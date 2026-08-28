import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import type { Message } from '../../shared/types'

export interface AgentModelTurnResult<TToolCall = unknown> {
  toolCalls: readonly TToolCall[]
}

export interface AgentModelTurnInput {
  messages: Message[]
  turn: number
  toolTurns: number
  signal?: AbortSignal
}

export interface AgentToolTurnInput<TResult extends AgentModelTurnResult> extends AgentModelTurnInput {
  modelResult: TResult
}

export type AgentRuntimeTerminalReason = 'complete' | 'unexpected_tool_call' | 'tool_turn_limit'

export interface AgentTerminalInput<TResult extends AgentModelTurnResult> extends AgentToolTurnInput<TResult> {
  terminalReason: AgentRuntimeTerminalReason
}

export interface AgentRuntimeOptions<TResult extends AgentModelTurnResult> {
  initialMessages: Message[]
  agentMode: boolean
  maxToolTurns: number
  signal?: AbortSignal
  checkpointer?: BaseCheckpointSaver
  threadId?: string
  resumeExisting?: boolean
  invokeModel(input: AgentModelTurnInput): Promise<TResult>
  executeTools(input: AgentToolTurnInput<TResult>): Promise<Message[]>
  onComplete(input: AgentTerminalInput<TResult>): Promise<void> | void
  onUnexpectedToolCall(input: AgentTerminalInput<TResult>): Promise<void> | void
  onToolTurnLimit(input: AgentTerminalInput<TResult>): Promise<void> | void
}

export interface AgentRuntimeResult<TResult extends AgentModelTurnResult> {
  messages: Message[]
  turn: number
  toolTurns: number
  modelResult: TResult
  terminalReason: AgentRuntimeTerminalReason
}

type AgentRoute = 'tools' | AgentRuntimeTerminalReason

/**
 * Runs the provider-neutral Agent state machine. Provider requests, tool
 * validation, approval, execution, and UI events stay in the supplied hooks.
 */
export async function runAgentRuntime<TResult extends AgentModelTurnResult>(
  options: AgentRuntimeOptions<TResult>,
): Promise<AgentRuntimeResult<TResult>> {
  disableRemoteTracing()
  if (!Number.isInteger(options.maxToolTurns) || options.maxToolTurns < 0) {
    throw new Error('Agent tool-turn limit must be a non-negative integer.')
  }
  throwIfAborted(options.signal)

  const RuntimeState = Annotation.Root({
    messages: Annotation<Message[]>(),
    turn: Annotation<number>(),
    toolTurns: Annotation<number>(),
    modelResult: Annotation<TResult | undefined>(),
    terminal: Annotation<boolean>(),
    terminalReason: Annotation<AgentRuntimeTerminalReason | undefined>(),
  })

  type RuntimeStateValue = typeof RuntimeState.State

  const modelNode = async (state: RuntimeStateValue): Promise<typeof RuntimeState.Update> => {
    throwIfAborted(options.signal)
    const turn = state.turn + 1
    const modelResult = await options.invokeModel({
      messages: state.messages,
      turn,
      toolTurns: state.toolTurns,
      signal: options.signal,
    })
    throwIfAborted(options.signal)
    return { turn, modelResult }
  }

  const routeModelTurn = (state: RuntimeStateValue): AgentRoute => {
    const modelResult = requireModelResult(state.modelResult)
    if (modelResult.toolCalls.length === 0) return 'complete'
    if (!options.agentMode) return 'unexpected_tool_call'
    if (state.toolTurns >= options.maxToolTurns) return 'tool_turn_limit'
    return 'tools'
  }

  const toolNode = async (state: RuntimeStateValue): Promise<typeof RuntimeState.Update> => {
    throwIfAborted(options.signal)
    const modelResult = requireModelResult(state.modelResult)
    const toolTurns = state.toolTurns + 1
    const messages = await options.executeTools({
      messages: state.messages,
      turn: state.turn,
      toolTurns,
      modelResult,
      signal: options.signal,
    })
    throwIfAborted(options.signal)
    return { messages, toolTurns, modelResult: undefined }
  }

  const terminalNode = (
    terminalReason: AgentRuntimeTerminalReason,
    callback: (input: AgentTerminalInput<TResult>) => Promise<void> | void,
  ) => {
    return async (state: RuntimeStateValue): Promise<typeof RuntimeState.Update> => {
      throwIfAborted(options.signal)
      const modelResult = requireModelResult(state.modelResult)
      await callback({
        messages: state.messages,
        turn: state.turn,
        toolTurns: state.toolTurns,
        modelResult,
        signal: options.signal,
        terminalReason,
      })
      throwIfAborted(options.signal)
      return { terminal: true, terminalReason }
    }
  }

  const graphBuilder = new StateGraph(RuntimeState)
    .addNode('model', modelNode)
    .addNode('tools', toolNode)
    .addNode(
      'complete',
      terminalNode('complete', (input) => options.onComplete(input)),
    )
    .addNode(
      'unexpected_tool_call',
      terminalNode('unexpected_tool_call', (input) => options.onUnexpectedToolCall(input)),
    )
    .addNode(
      'tool_turn_limit',
      terminalNode('tool_turn_limit', (input) => options.onToolTurnLimit(input)),
    )
    .addEdge(START, 'model')
    .addConditionalEdges('model', routeModelTurn)
    .addEdge('tools', 'model')
    .addEdge('complete', END)
    .addEdge('unexpected_tool_call', END)
    .addEdge('tool_turn_limit', END)
  const graph = graphBuilder.compile(options.checkpointer ? { checkpointer: options.checkpointer } : undefined)

  const initialState: RuntimeStateValue = {
    messages: [...options.initialMessages],
    turn: 0,
    toolTurns: 0,
    modelResult: undefined,
    terminal: false,
    terminalReason: undefined,
  }
  const configurable = options.checkpointer && options.threadId ? { thread_id: options.threadId } : undefined
  const existing =
    options.resumeExisting && options.checkpointer && configurable
      ? await options.checkpointer.getTuple({ configurable })
      : undefined
  const state = await AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: [] }, () =>
    graph.invoke(existing ? null : initialState, {
      signal: options.signal,
      // Each tool turn visits model and tools. Leave headroom for the terminal
      // node and LangGraph's input/output supersteps at the configured maximum.
      recursionLimit: options.maxToolTurns * 2 + 8,
      configurable,
    }),
  )

  if (!state.terminal || !state.terminalReason || !state.modelResult) {
    throw new Error('Agent runtime ended without a terminal state.')
  }
  return {
    messages: state.messages,
    turn: state.turn,
    toolTurns: state.toolTurns,
    modelResult: state.modelResult,
    terminalReason: state.terminalReason,
  }
}

function requireModelResult<TResult extends AgentModelTurnResult>(result: TResult | undefined): TResult {
  if (!result) throw new Error('Agent runtime model result is unavailable.')
  return result
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function disableRemoteTracing(): void {
  process.env.LANGSMITH_TRACING = 'false'
  process.env.LANGSMITH_TRACING_V2 = 'false'
  process.env.LANGCHAIN_TRACING_V2 = 'false'
  delete process.env.LANGCHAIN_TRACING
}
