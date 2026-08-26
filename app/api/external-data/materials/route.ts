import { externalApiErrorResponse, queryAdxMaterials, successResponse, type MaterialQuery } from "../../../lib/server/external-open-api";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const requestId = request.headers.get("X-Request-Id") || crypto.randomUUID();
  let body: MaterialQuery;
  try {
    body = (await request.json()) as MaterialQuery;
  } catch {
    return Response.json(
      { code: 2001, message: "请求体必须是有效 JSON", data: null, request_id: requestId },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  const allowed = new Set(["drama_name", "country_id", "start_date", "end_date", "page", "page_size"]);
  const extraField = Object.keys(body).find((key) => !allowed.has(key));
  const dramaName = typeof body.drama_name === "string" ? body.drama_name.trim() : "";
  const countryValid = body.country_id === undefined || [1, 13, 24].includes(body.country_id);
  const pageValid = body.page === undefined || (Number.isInteger(body.page) && body.page >= 1);
  const pageSizeValid = body.page_size === undefined || (Number.isInteger(body.page_size) && body.page_size >= 1 && body.page_size <= 100);
  const datesValid = (!body.start_date || DATE_PATTERN.test(body.start_date)) && (!body.end_date || DATE_PATTERN.test(body.end_date)) && (!body.start_date || !body.end_date || body.start_date <= body.end_date);

  if (extraField || !dramaName || dramaName.length > 500 || !countryValid || !pageValid || !pageSizeValid || !datesValid) {
    return Response.json(
      { code: 2001, message: extraField ? `不支持的字段：${extraField}` : "ADX 素材查询参数不合法", data: null, request_id: requestId },
      { status: 400, headers: { "X-Request-Id": requestId } },
    );
  }

  try {
    return successResponse(await queryAdxMaterials({ ...body, drama_name: dramaName }, requestId), requestId);
  } catch (error) {
    return externalApiErrorResponse(error);
  }
}
