import { NextRequest, NextResponse } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { validatePreRollContext, validatePreRollIdea } from '@/app/lib/pre-roll-script';
import { generatePreRoll } from '@/app/lib/pre-roll-generator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin !== request.nextUrl.origin || (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return NextResponse.json({ message: '不允许跨站生成请求' }, { status: 403 });
  if (!await getChatGPTUser()) return NextResponse.json({ message: '请先登录' }, { status: 401 });
  let context: ReturnType<typeof validatePreRollContext>;
  let idea: ReturnType<typeof validatePreRollIdea> | undefined;
  let count = 3;
  let existingIdeas: ReturnType<typeof validatePreRollIdea>[] = [];
  try {
    const raw = await request.text();
    if (raw.length > 250_000) return NextResponse.json({ message: '故事线输入过大，请缩小正片范围' }, { status: 413 });
    const body = JSON.parse(raw);
    if (!['ideas', 'script'].includes(body.action)) throw new Error('未知生成操作');
    context = validatePreRollContext(body.context);
    if (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 3)) throw new Error('生成数量须为 1–3');
    count = body.count ?? 3;
    if (body.existingIdeas !== undefined) {
      if (!Array.isArray(body.existingIdeas) || body.existingIdeas.length > 2 || body.existingIdeas.length + count > 3) throw new Error('补生成数量无效');
      existingIdeas = body.existingIdeas.map((v: unknown) => validatePreRollIdea(v, context.plan.segments.length));
    }
    idea = body.action === 'script' ? validatePreRollIdea(body.idea, context.plan.segments.length) : undefined;
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : '输入无效' }, { status: 400 });
  }
  const config = {
    endpoint: process.env.LUMINA_SEMANTIC_ENDPOINT || '',
    model: process.env.LUMINA_PREROLL_MODEL || process.env.LUMINA_SEMANTIC_MODEL || '',
    key: process.env.LUMINA_SEMANTIC_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY || '',
  };
  if (!config.endpoint || !config.model || !config.key) return NextResponse.json({ message: '尚未配置前贴生成模型，请在服务端配置 LUMINA_SEMANTIC_ENDPOINT、LUMINA_SEMANTIC_MODEL 和模型密钥' }, { status: 503 });
  try {
    return NextResponse.json(await generatePreRoll(context, idea, config, request.signal, { count, existingIdeas }), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error && /模型|前贴|配置|脚本|校验/.test(error.message) ? error.message : '生成中断或超时，请重试';
    return NextResponse.json({ message }, { status: 502 });
  }
}
