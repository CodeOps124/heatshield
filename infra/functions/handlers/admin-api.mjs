// Lambda entry point: the admin console API. Sign-in is Amazon Cognito; API Gateway's JWT authorizer
// verifies the token before this code runs, and admin-routes.mjs requires the "admins" group.
import { createAdminApi } from '../lib/admin-routes.mjs';
import { createAgentLog } from '../lib/agent-log.mjs';
import { createAgentsApi } from '../lib/agents-api.mjs';
import { createControl } from '../lib/control.mjs';
import { createStore } from '../lib/store.mjs';
import { dynamo, tables, invokeAgentAsync, invokeAgentSync, failedRuns, alarmStates } from '../lib/aws.mjs';

const agentLog = createAgentLog({ db: dynamo, table: tables.agentLog });
const control = createControl({ agentLog, ttlMs: 0 }); // the console always reads the current settings
const store = createStore({ db: dynamo, tables });

export const handler = createAdminApi({
  agentLog,
  control,
  cache: store.guidanceCache,
  agentsApi: createAgentsApi({ agentLog, control }),
  invokeAgent: (agentId, payload, { wait }) => (wait ? invokeAgentSync(agentId, payload) : invokeAgentAsync(agentId, payload)),
  failedRuns,
  alarms: alarmStates,
});
