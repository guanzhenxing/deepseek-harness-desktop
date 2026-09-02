export interface SharedHomeFixture {
  userData: string
  home: string
  cwd: string
  mockLlm: { requests: { url: string; authorization: string; body: string }[] }
  sentinel: string
  baseURL: string
  dispose(): Promise<void>
}

export interface WebApiClient {
  rpc<T = unknown>(method: string, args: Record<string, unknown>): Promise<T>
}

export interface DshNativeResult {
  code: number | null
  signal: string | null
  output: string
}

export function createSharedHomeFixture(): Promise<SharedHomeFixture>
export function runDshNative(
  argv: readonly string[],
  options?: { home: string; cwd?: string; env?: Record<string, string> },
): Promise<DshNativeResult>
export function withDesktop(
  home: string,
  userData: string,
  action: (input: { client: WebApiClient; surfaceUrl: string }) => Promise<void>,
): Promise<void>
export function withCliWeb(
  home: string,
  cwd: string,
  action: (input: { client: WebApiClient; surfaceUrl: string }) => Promise<void>,
): Promise<void>
export function createWebApiClient(surfaceUrl: string): Promise<WebApiClient>
export function listSessions(
  home: string,
): Promise<
  {
    file: string
    header: { id: string; cwd: string }
    turns: number
  }[]
>
export function waitForTurns(sessionFile: string, expected: number, timeoutMs?: number): Promise<number>
export function driveOneTurn(client: WebApiClient, input: {
  cwd: string
  sessionId?: string
  text?: string
}): Promise<string>
export function firstSessionId(client: WebApiClient): Promise<string | undefined>
export function runSharedHomeScenario(
  direction: 'cli-to-desktop' | 'desktop-to-cli',
): Promise<{ sessionId: string; persistedTurns: number; home: string }>
