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
import { CloudWatchLogsClient, FilterLogEventsCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SQSClient, GetQueueAttributesCommand, ReceiveMessageCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';

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
  agentLog: process.env.AGENT_LOG_TABLE,
};

// The reviewer model writes only as a last resort (the writer failed twice), e.g. a runaway reply.
export const models = [...new Set([process.env.BEDROCK_MODEL_ID, process.env.BEDROCK_FALLBACK_MODEL_ID, process.env.REVIEWER_MODEL_ID].filter(Boolean))];
/** Tool-using agents (Sol, Kai, Otto) and the reviewers (Lexi, Vera; a different model family from the writer). */
export const agentModels = [process.env.AGENT_MODEL_ID, process.env.BEDROCK_FALLBACK_MODEL_ID].filter(Boolean);
export const reviewerModels = [process.env.REVIEWER_MODEL_ID, process.env.AGENT_MODEL_ID].filter(Boolean);

// ---------------------------------------------------------------- CloudWatch Logs (Otto)
const cwl = new CloudWatchLogsClient({});

function sanitizeLogLine(message) {
  const text = String(message ?? '').trim();
  const brace = text.indexOf('{');
  if (brace !== -1) {
    try {
      const j = JSON.parse(text.slice(brace));
      const keep = ['level', 'msg', 'message', 'error', 'name', 'route', 'modelId', 'code'];
      return JSON.stringify(Object.fromEntries(keep.filter((k) => j[k] !== undefined).map((k) => [k, String(j[k]).slice(0, 200)])));
    } catch { /* not JSON */ }
  }
  return text.slice(0, 240);
}

export const logs = {
  /** Names of log groups starting with `prefix`. */
  async listGroups(prefix) {
    const names = [];
    let nextToken;
    do {
      const res = await cwl.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }));
      names.push(...(res.logGroups ?? []).map((g) => g.logGroupName));
      nextToken = res.nextToken;
    } while (nextToken);
    return names;
  },
  /** Count matching log events since `startMs` (capped at 5 pages). */
  async count(logGroupName, filterPattern, startMs) {
    let total = 0;
    let nextToken;
    for (let page = 0; page < 5; page += 1) {
      const res = await cwl.send(new FilterLogEventsCommand({ logGroupName, filterPattern, startTime: startMs, nextToken, limit: 1000 }));
      total += res.events?.length ?? 0;
      nextToken = res.nextToken;
      if (!nextToken) break;
    }
    return total;
  },
  /** Most recent matching lines, reduced to non-sensitive fields. */
  async sample(logGroupName, filterPattern, startMs, limit = 8) {
    const res = await cwl.send(new FilterLogEventsCommand({ logGroupName, filterPattern, startTime: startMs, limit: 50 }));
    return (res.events ?? []).slice(-limit).map((e) => ({ at: new Date(e.timestamp).toISOString(), line: sanitizeLogLine(e.message) }));
  },
};

export const opsPublish = async (subject, message) => {
  if (!process.env.OPS_TOPIC_ARN) return;
  await sns.send(new PublishCommand({ TopicArn: process.env.OPS_TOPIC_ARN, Subject: subject, Message: message }));
};

// ---------------------------------------------------------------- Lambda invoke (on-demand coordinator)
const lambda = new LambdaClient({});
async function invokeSync(functionName, payload) {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  const body = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString('utf8') || 'null') : null;
  if (res.FunctionError) throw new Error(body?.errorMessage ?? `${functionName} failed`);
  return body;
}

export const invokeCoordinator = (groupId) => invokeSync(process.env.COORDINATOR_FUNCTION, { groupId, trigger: 'leader-request' });

/** Visitor-triggered runs of Sol / Otto from Agent HQ (budget keeps them inside the web request). */
const ON_DEMAND = { sol: 'SENTINEL_FUNCTION', otto: 'WATCHDOG_FUNCTION' };
export async function invokeAgent(agentId) {
  const fn = process.env[ON_DEMAND[agentId]];
  if (!fn) throw new Error(`Agent ${agentId} cannot be run on demand`);
  return invokeSync(fn, { trigger: 'visitor', budgetMs: 20_000 });
}

// ---------------------------------------------------------------- agents by name (no template references)
// Otto and the admin console invoke agents by the stack's naming convention rather than by template
// reference: the public API invokes Otto, and a reference chain back to the distribution would be a
// CloudFormation dependency cycle. Function names come from their log groups (/aws/lambda/<name>).
export const AGENT_FUNCTIONS = Object.freeze({
  sol: 'SentinelFunction', kai: 'CoordinatorFunction', otto: 'WatchdogFunction',
  dispatch: 'AlertCheckFunction', quinn: 'AuditorFunction', iris: 'CoachFunction',
});
let functionNames = null;
export async function functionFor(agentId) {
  const logical = AGENT_FUNCTIONS[agentId];
  if (!logical) throw new Error(`Unknown agent ${agentId}`);
  if (!functionNames) {
    const prefix = `/aws/lambda/${process.env.STACK_NAME}-`;
    functionNames = (await logs.listGroups(prefix)).map((g) => g.slice('/aws/lambda/'.length));
  }
  const name = functionNames.find((n) => n.startsWith(`${process.env.STACK_NAME}-${logical}-`));
  if (!name) throw new Error(`No deployed function for ${agentId}`);
  return name;
}

/** Fire-and-forget run (a failed attempt is retried once, then lands in the dead-letter queue). */
export async function invokeAgentAsync(agentId, payload) {
  await lambda.send(new InvokeCommand({
    FunctionName: await functionFor(agentId),
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
}

/** Waits for the run's result (the admin console's "Run now"). */
export async function invokeAgentSync(agentId, payload) {
  return invokeSync(await functionFor(agentId), payload);
}

// ---------------------------------------------------------------- failed scheduled runs (dead-letter queue)
const sqs = new SQSClient({});
const queueUrl = () => process.env.FAILED_RUNS_QUEUE_URL;
export const failedRuns = {
  async count() {
    if (!queueUrl()) return null;
    const res = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl(), AttributeNames: ['ApproximateNumberOfMessages'] }));
    return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0);
  },
  /** Looks without consuming (visibility timeout 0), reduced to what the console needs. */
  async peek(max = 10) {
    if (!queueUrl()) return [];
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl(), MaxNumberOfMessages: Math.min(10, max), VisibilityTimeout: 0, WaitTimeSeconds: 0, MessageSystemAttributeNames: ['SentTimestamp'] }));
    return (res.Messages ?? []).map((m) => {
      let body = {};
      try { body = JSON.parse(m.Body); } catch { /* not a Lambda destination record */ }
      return {
        at: new Date(Number(m.Attributes?.SentTimestamp ?? 0)).toISOString(),
        function: String(body.requestContext?.functionArn ?? '').split(':').slice(6, 7)[0] ?? null,
        condition: body.requestContext?.condition ?? null,
        attempts: body.requestContext?.approximateInvokeCount ?? null,
        error: String(body.responsePayload?.errorMessage ?? body.responsePayload?.errorType ?? '').slice(0, 300),
      };
    });
  },
  async purge() {
    if (queueUrl()) await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl() }));
  },
};

// ---------------------------------------------------------------- alarm states (admin console)
const cloudwatch = new CloudWatchClient({});
export async function alarmStates() {
  const res = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: `${process.env.STACK_NAME}-`, MaxRecords: 50 }));
  return (res.MetricAlarms ?? []).map((a) => ({
    name: a.AlarmName.replace(`${process.env.STACK_NAME}-`, ''),
    state: a.StateValue,
    description: a.AlarmDescription ?? '',
    since: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : null,
  }));
}
