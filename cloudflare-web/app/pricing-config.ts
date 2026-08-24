export type PricingSettings = {
  adultPrice: number;
  youthPrice: number;
  naverDepositAmount: number;
  naverCancellationFeeAmount: number;
  slushPrice: number;
  beveragePrice: number;
  otherPrice: number;
  youthPass10Price: number;
  youthPass20Price: number;
  adultPass10Price: number;
  adultPass20Price: number;
};

export type SharedSalesCategory =
  | "slush"
  | "beverage"
  | "other"
  | "youthPass10"
  | "youthPass20"
  | "adultPass10"
  | "adultPass20";

// 매장별 상의: 아래 금액은 화면 초기값이며 지점별 확정 가격으로 변경합니다.
export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  adultPrice: 7_000,
  youthPrice: 5_000,
  naverDepositAmount: 5_000,
  naverCancellationFeeAmount: 5_000,
  slushPrice: 1_500,
  beveragePrice: 1_000,
  otherPrice: 1_000,
  youthPass10Price: 45_000,
  youthPass20Price: 80_000,
  adultPass10Price: 60_000,
  adultPass20Price: 110_000,
};

export function sharedSalesUnitPrices(
  pricing: PricingSettings,
): Record<SharedSalesCategory, number> {
  return {
    slush: pricing.slushPrice,
    beverage: pricing.beveragePrice,
    other: pricing.otherPrice,
    youthPass10: pricing.youthPass10Price,
    youthPass20: pricing.youthPass20Price,
    adultPass10: pricing.adultPass10Price,
    adultPass20: pricing.adultPass20Price,
  };
}

export function calculateConfiguredBaseAmount(
  adultCount: number,
  youthCount: number,
  pricing: PricingSettings,
) {
  return adultCount * pricing.adultPrice + youthCount * pricing.youthPrice;
}

export function sanitizePricingSettings(input: unknown): PricingSettings | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const result = {} as PricingSettings;

  for (const key of Object.keys(DEFAULT_PRICING_SETTINGS) as Array<keyof PricingSettings>) {
    const value = Number(source[key]);
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000) return null;
    result[key] = value;
  }

  return result;
}
