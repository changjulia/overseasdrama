import { getChatGPTUser } from "@/app/chatgpt-auth";
import { externalApiErrorResponse, getDramaPlayback, successResponse } from "../../../lib/server/external-open-api";

export async function GET(request: Request) {
  if (!await getChatGPTUser()) {
    return Response.json({ code: 401, message: "请先登录", data: null }, { status: 401 });
  }
  const requestId = request.headers.get("X-Request-Id") || crypto.randomUUID();
  const name = new URL(request.url).searchParams.get("name")?.trim() || "";
  if (!name || name.length > 500) {
    return Response.json(
      { code: 2001, message: "name 必填，长度必须为 1～500 个字符", data: null, request_id: requestId },
      { status: 400, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  }
  try {
    return successResponse(await getDramaPlayback(name, requestId), requestId);
  } catch (error) {
    return externalApiErrorResponse(error);
  }
}
