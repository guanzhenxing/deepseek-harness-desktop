export interface IsolatedHomeFixture {
  readonly home: string
  readonly userData: string
  dispose(): Promise<void>
}

export declare function createIsolatedHomeFixture(): Promise<IsolatedHomeFixture>
