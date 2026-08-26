import { externalApiErrorResponse, getMonthlyRankings, successResponse } from "../../../lib/server/external-open-api";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: Request) {
  const requestId = request.headers.get("X-Request-Id") || crypto.randomUUID();
  const month = new URL(request.url).searchParams.get("month")?.trim();
  if (month && !MONTH_PATTERN.test(month)) {
    return Response.json(
      { code: 2001, message: "month 必须使用 YYYY-MM 格式", data: null, request_id: requestId },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }
  try {
    return successResponse(await getMonthlyRankings(month, requestId), requestId);
  } catch (error) {
    return externalApiErrorResponse(error);
  }
}
