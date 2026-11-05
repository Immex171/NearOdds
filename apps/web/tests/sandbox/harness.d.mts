/* eslint-disable @typescript-eslint/no-explicit-any */
export const sandboxAvailable: () => boolean;
export const startSandbox: () => Promise<any>;
export const createAccount: (sbx: any, name: string, near?: bigint) => Promise<any>;
export const deployToken: (sbx: any, owner: any, name?: string) => Promise<string>;
export const deployMarket: (sbx: any, o: any) => Promise<any>;
export const call: (sbx: any, k: any, receiver: string, method: string, args: object, deposit?: bigint, gas?: bigint, label?: string) => Promise<any>;
export const view: (sbx: any, contractId: string, method: string, args?: object) => Promise<any>;
