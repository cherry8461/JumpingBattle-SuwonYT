import { getOperator } from "@/app/operator";
import { sanitizePricingSettings } from "@/app/pricing-config";
import {
  getPricingSettings,
  updatePricingSettings,
} from "@/db/pricing-settings";

export async function GET() {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  return Response.json(
    { pricing: await getPricingSettings() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  try {
    const pricing = sanitizePricingSettings(await request.json());
    if (!pricing) {
      return Response.json(
        { error: "모든 금액을 0원 이상 1,000만원 이하의 숫자로 입력해 주세요." },
        { status: 400 },
      );
    }
    return Response.json({
      pricing: await updatePricingSettings(pricing, operator.email),
    });
  } catch {
    return Response.json({ error: "가격 설정을 저장하지 못했습니다." }, { status: 500 });
  }
}
