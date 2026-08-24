import {
  DEFAULT_PRICING_SETTINGS,
  type PricingSettings,
} from "@/app/pricing-config";
import { getD1 } from "./control";

type PricingSettingsRow = {
  adult_price: number;
  youth_price: number;
  naver_deposit_amount: number;
  naver_cancellation_fee_amount: number;
  slush_price: number;
  beverage_price: number;
  other_price: number;
  youth_pass_10_price: number;
  youth_pass_20_price: number;
  adult_pass_10_price: number;
  adult_pass_20_price: number;
  updated_at: string;
};

export type StoredPricingSettings = PricingSettings & { updatedAt: string };

export async function ensurePricingSettingsSchema() {
  const db = getD1();
  const defaults = DEFAULT_PRICING_SETTINGS;
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS pricing_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        adult_price INTEGER NOT NULL DEFAULT 7000,
        youth_price INTEGER NOT NULL DEFAULT 5000,
        naver_deposit_amount INTEGER NOT NULL DEFAULT 5000,
        naver_cancellation_fee_amount INTEGER NOT NULL DEFAULT 5000,
        slush_price INTEGER NOT NULL DEFAULT 1500,
        beverage_price INTEGER NOT NULL DEFAULT 1000,
        other_price INTEGER NOT NULL DEFAULT 1000,
        youth_pass_10_price INTEGER NOT NULL DEFAULT 45000,
        youth_pass_20_price INTEGER NOT NULL DEFAULT 80000,
        adult_pass_10_price INTEGER NOT NULL DEFAULT 60000,
        adult_pass_20_price INTEGER NOT NULL DEFAULT 110000,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      INSERT OR IGNORE INTO pricing_settings (
        id, adult_price, youth_price, naver_deposit_amount,
        naver_cancellation_fee_amount, slush_price, beverage_price,
        other_price, youth_pass_10_price, youth_pass_20_price,
        adult_pass_10_price, adult_pass_20_price
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      defaults.adultPrice,
      defaults.youthPrice,
      defaults.naverDepositAmount,
      defaults.naverCancellationFeeAmount,
      defaults.slushPrice,
      defaults.beveragePrice,
      defaults.otherPrice,
      defaults.youthPass10Price,
      defaults.youthPass20Price,
      defaults.adultPass10Price,
      defaults.adultPass20Price,
    ),
  ]);
}

function mapPricingSettings(row: PricingSettingsRow): StoredPricingSettings {
  return {
    adultPrice: row.adult_price,
    youthPrice: row.youth_price,
    naverDepositAmount: row.naver_deposit_amount,
    naverCancellationFeeAmount: row.naver_cancellation_fee_amount,
    slushPrice: row.slush_price,
    beveragePrice: row.beverage_price,
    otherPrice: row.other_price,
    youthPass10Price: row.youth_pass_10_price,
    youthPass20Price: row.youth_pass_20_price,
    adultPass10Price: row.adult_pass_10_price,
    adultPass20Price: row.adult_pass_20_price,
    updatedAt: row.updated_at,
  };
}

export async function getPricingSettings(): Promise<StoredPricingSettings> {
  await ensurePricingSettingsSchema();
  const row = await getD1()
    .prepare(`
      SELECT adult_price, youth_price, naver_deposit_amount,
        naver_cancellation_fee_amount, slush_price, beverage_price,
        other_price, youth_pass_10_price, youth_pass_20_price,
        adult_pass_10_price, adult_pass_20_price, updated_at
      FROM pricing_settings WHERE id = 1
    `)
    .first<PricingSettingsRow>();
  if (!row) return { ...DEFAULT_PRICING_SETTINGS, updatedAt: "" };
  return mapPricingSettings(row);
}

export async function updatePricingSettings(
  pricing: PricingSettings,
  updatedBy: string,
): Promise<StoredPricingSettings> {
  await ensurePricingSettingsSchema();
  await getD1()
    .prepare(`
      UPDATE pricing_settings SET
        adult_price = ?, youth_price = ?, naver_deposit_amount = ?,
        naver_cancellation_fee_amount = ?, slush_price = ?,
        beverage_price = ?, other_price = ?, youth_pass_10_price = ?,
        youth_pass_20_price = ?, adult_pass_10_price = ?,
        adult_pass_20_price = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `)
    .bind(
      pricing.adultPrice,
      pricing.youthPrice,
      pricing.naverDepositAmount,
      pricing.naverCancellationFeeAmount,
      pricing.slushPrice,
      pricing.beveragePrice,
      pricing.otherPrice,
      pricing.youthPass10Price,
      pricing.youthPass20Price,
      pricing.adultPass10Price,
      pricing.adultPass20Price,
      updatedBy,
    )
    .run();
  return getPricingSettings();
}
