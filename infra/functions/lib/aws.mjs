/**
 * The only module that touches the AWS SDK. Everything else takes these adapters as
 * dependencies, which keeps the business logic unit-testable without AWS credentials.
 * AWS SDK for JavaScript v3 is provided by the Lambda Node.js runtime (no bundling needed).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand, ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  SNSClient, SubscribeCommand, UnsubscribeCommand, PublishCommand, GetSubscriptionAttributesCommand,
} from '@aws-sdk/client-sns';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Generic DynamoDB adapter used by store.mjs. */
export const dynamo = {
  async get({ table, key }) {
    const res = await doc.send(new GetCommand({ TableName: table, Key: key }));
    return res.Item ?? null;
  },
  async put({ table, item, condition, names, values }) {
    await doc.send(new PutCommand({
      TableName: table,
      Item: item,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  },
  async update({ table, key, update, condition, names, values }) {
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: key,
      UpdateExpression: update,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  },
  async delete({ table, key }) {
    await doc.send(new DeleteCommand({ TableName: table, Key: key }));
  },
  async query({ table, index, keyCondition, names, values, limit = 100, forward = true }) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await doc.send(new QueryCommand({
        TableName: table,
        IndexName: index,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: forward,
        Limit: limit - items.length,
        ExclusiveStartKey,
      }));
      items.push(...(res.Items ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < limit);
    return items;
  },
  async scanAll({ table }) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
      items.push(...(res.Items ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  },
};

// Bedrock may live in a different region than the stack (model availability), so it is
// configurable; retries are kept low because the guidance service has its own fallback chain.
const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION,
  maxAttempts: 2,
});
export const converse = (params, opts) => bedrock.send(new ConverseCommand(params), opts);

const sns = new SNSClient({});
const topicArn = () => process.env.ALERTS_TOPIC_ARN;

export const notifier = {
  /**
   * One shared topic; each person's email subscription carries a filter policy on their
   * locationId, so a publish reaches exactly that person. AWS sends the confirmation email;
   * nothing is delivered until the person clicks "Confirm subscription" (double opt-in).
   */
  async subscribeEmail(email, locationId) {
    const res = await sns.send(new SubscribeCommand({
      TopicArn: topicArn(),
      Protocol: 'email',
      Endpoint: email,
      ReturnSubscriptionArn: true,
      Attributes: {
        FilterPolicyScope: 'MessageAttributes',
        FilterPolicy: JSON.stringify({ locationId: [locationId] }),
      },
    }));
    return res.SubscriptionArn;
  },
  async unsubscribe(subscriptionArn) {
    await sns.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
  },
  async subscriptionStatus(subscriptionArn) {
    const res = await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: subscriptionArn }));
    return res.Attributes?.PendingConfirmation === 'true' ? 'pending' : 'confirmed';
  },
  async publishAlert({ locationId, subject, message }) {
    const res = await sns.send(new PublishCommand({
      TopicArn: topicArn(),
      Subject: subject,
      Message: message,
      MessageAttributes: { locationId: { DataType: 'String', StringValue: locationId } },
    }));
    return res.MessageId;
  },
};

export const tables = {
  groups: process.env.GROUPS_TABLE,
  locations: process.env.LOCATIONS_TABLE,
  alerts: process.env.ALERTS_TABLE,
  guidanceCache: process.env.GUIDANCE_CACHE_TABLE,
};

export const models = [process.env.BEDROCK_MODEL_ID, process.env.BEDROCK_FALLBACK_MODEL_ID].filter(Boolean);
