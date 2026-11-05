import { config } from "../config";
import { createApi } from "./client";

let token: string | null = null;
/** The bearer token of the current application session (null = signed out). */
export const setApiToken = (t: string | null) => { token = t; };
export const api = createApi({ baseUrl: config.apiUrl, token: () => token });
