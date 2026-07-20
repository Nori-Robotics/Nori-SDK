/** Cylindrical (task-space) DOFs a `reach` accepts — derived from TASK_KEYS. */
export declare const REACH_DOFS: string[];
/** Per-joint DOFs `joint`/`move_to` accept — derived from JOINT_KEYS. */
export declare const JOINT_DOFS: string[];
/** Mobile-base DOFs `base` accepts — derived from BASE_KEYS. */
export declare const BASE_DOFS: string[];
/** How a capability is exposed as an Anthropic tool to the agent loop. */
export interface AgentSurface {
    /** Anthropic tool name (what the model calls, dispatched in AgentSession.execTool). */
    tool: string;
    /** `description` sent to the model. */
    summary: string;
    /** Anthropic `input_schema` (JSON Schema). Kept verbatim-equal to the shipped schema. */
    input_schema: Record<string, unknown>;
    /** True if this tool commands motion (trips confirm-before-first-motion; see MOTION_TOOLS). */
    motion: boolean;
}
/** How a capability is exposed on the codegen `nori.*` JS API (`robot` is a legacy alias). */
export interface CodegenSurface {
    /** Method name: `nori.<js>`. */
    js: string;
    /** Human signature for the API reference, e.g. "(side, targets, opts?)". */
    signature: string;
    /** One-line reference summary. */
    summary: string;
}
/** One robot capability and its per-surface exposure. */
export interface RobotOp {
    /** Stable capability id (surface-independent). */
    cap: string;
    /**
     * The ScriptDriver.exec(op) case this maps to, if any. Undefined for capabilities that don't go
     * through the driver: agent meta-tools (look/get_state/done/give_up) and composed codegen
     * primitives (home/stow/…). The drift test asserts every defined driverOp is a real exec case.
     */
    driverOp?: string;
    agent?: AgentSurface;
    codegen?: CodegenSurface;
}
export declare const ROBOT_OPS: RobotOp[];
/** The Anthropic tools array — drop-in for lelab/server.py NORI_AGENT_TOOLS. */
export declare function buildAgentTools(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}>;
/** Tool names that command motion (mirror of AgentSession MOTION_TOOLS). */
export declare function agentMotionTools(): string[];
/** Every ScriptDriver.exec case named by the manifest (for the executor drift test). */
export declare function driverOps(): string[];
/** Every agent tool name (for the AgentSession dispatch drift test). */
export declare function agentToolNames(): string[];
/** Render the "THE ROBOT / TOOLS" reference block for the agent system prompt. */
export declare function renderAgentToolsRef(): string;
/** Render the "THE ROBOT API" reference block for the codegen system prompt. */
export declare function renderCodegenApiRef(): string;
/**
 * The full generated bundle LeLab's Python reads (robot-tools.json). Stable key order + the derived
 * DOF lists (resolved here so Python doesn't need the SDK's TS). The drift test golden-compares the
 * committed file against this.
 */
export declare function buildRobotToolsBundle(): Record<string, unknown>;
//# sourceMappingURL=robot-ops.d.ts.map