// The request path for operations, independent of the transport (A2 3.6.4, A3 3.2): the local
// endpoint registers it as `op/call` and `op/list`; MCP (M2.02, M2.03) and HTTP (M2.12) call the
// same functions with their own caller.
export {
  defaultOf,
  opCall,
  opList,
  personSpace,
  type OpCallParams,
  type OpsHost,
  type ServedSpace,
  type UsableSpace,
} from "./handlers.ts";
export { principalOf, isUserClass, type Caller, type Principal } from "./caller.ts";
export { dueDate, localTimeZone } from "./dates.ts";
export { readAgentSessions, readSpace, type AgentSessionRow, type SpaceFacts } from "./read.ts";
export {
  BOUND_BY,
  UNBOUND_REASONS,
  type Binding,
  type BoundBy,
  type Decision,
  type Presented,
  type Session,
  type SessionHome,
  type SessionPort,
  type Standing,
  type UnboundReason,
} from "./binding.ts";
export { readOnly } from "./errors.ts";
export { grantRefused, MANUAL_INSTANCE, type HomeGate } from "./grant.ts";
