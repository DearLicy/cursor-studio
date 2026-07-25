/**
 * Node/Electron 实验性 sqlite 最小类型（@types/node@20 尚未收录）。
 */
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      run: (...params: unknown[]) => unknown;
      get: (...params: unknown[]) => unknown;
      all: (...params: unknown[]) => unknown[];
    };
    close(): void;
  }
}