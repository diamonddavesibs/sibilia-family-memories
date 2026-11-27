import { handleApi } from "../../lib/api.js";

export async function onRequest(context) {
  return handleApi(context.request, context.env, context.data.user);
}
