"use client";

import { useMemo, useState } from "react";
import type { PricingSettings } from "@/app/pricing-config";
import type { StoredPricingSettings } from "@/db/pricing-settings";

type Field = {
  key: keyof PricingSettings;
  label: string;
  description: string;
};

const FIELD_GROUPS: Array<{ title: string; description: string; fields: Field[] }> = [
  {
    title: "게임 이용 요금",
    description: "새로 접수하거나 관리자가 직접 입력하는 예약의 기본 게임비입니다.",
    fields: [
      { key: "adultPrice", label: "성인 1인", description: "고객 예약·직접 예약" },
      { key: "youthPrice", label: "청소년·어린이 1인", description: "고객 예약·직접 예약" },
    ],
  },
  {
    title: "공용 부가매출",
    description: "수량을 입력했을 때 자동 계산되는 개당 판매가입니다.",
    fields: [
      { key: "slushPrice", label: "슬러시", description: "1개 단가" },
      { key: "beveragePrice", label: "음료", description: "1개 단가" },
      { key: "otherPrice", label: "기타", description: "1개 단가" },
    ],
  },
  {
    title: "다회권",
    description: "공용 부가매출에서 판매 수량을 입력할 때 적용되는 금액입니다.",
    fields: [
      { key: "youthPass10Price", label: "청소년 10회", description: "다회권 판매가" },
      { key: "youthPass20Price", label: "청소년 20회", description: "다회권 판매가" },
      { key: "adultPass10Price", label: "성인 10회", description: "다회권 판매가" },
      { key: "adultPass20Price", label: "성인 20회", description: "다회권 판매가" },
    ],
  },
  {
    title: "네이버 예약",
    description: "네이버 예약 결제와 당일 취소 매출에 사용하는 기준 금액입니다.",
    fields: [
      { key: "naverDepositAmount", label: "예약금", description: "현장 결제금 계산" },
      { key: "naverCancellationFeeAmount", label: "당일 취소 수수료", description: "네이버 당일 취소 매출" },
    ],
  },
];

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

export default function PricingSettingsForm({
  initialPricing,
  operatorName,
}: {
  initialPricing: StoredPricingSettings;
  operatorName: string;
}) {
  const initialValues = useMemo<PricingSettings>(() => ({
    adultPrice: initialPricing.adultPrice,
    youthPrice: initialPricing.youthPrice,
    naverDepositAmount: initialPricing.naverDepositAmount,
    naverCancellationFeeAmount: initialPricing.naverCancellationFeeAmount,
    slushPrice: initialPricing.slushPrice,
    beveragePrice: initialPricing.beveragePrice,
    otherPrice: initialPricing.otherPrice,
    youthPass10Price: initialPricing.youthPass10Price,
    youthPass20Price: initialPricing.youthPass20Price,
    adultPass10Price: initialPricing.adultPass10Price,
    adultPass20Price: initialPricing.adultPass20Price,
  }), [initialPricing]);
  const [values, setValues] = useState(initialValues);
  const [savedValues, setSavedValues] = useState(initialValues);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const changed = JSON.stringify(values) !== JSON.stringify(savedValues);

  function changeValue(key: keyof PricingSettings, rawValue: string) {
    const next = Math.max(0, Math.min(10_000_000, Math.trunc(Number(rawValue) || 0)));
    setValues((current) => ({ ...current, [key]: next }));
    setNotice("");
  }

  async function save() {
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = (await response.json()) as { pricing?: StoredPricingSettings; error?: string };
      if (!response.ok || !data.pricing) throw new Error(data.error ?? "저장하지 못했습니다.");
      const next = Object.fromEntries(
        (Object.keys(values) as Array<keyof PricingSettings>).map((key) => [key, data.pricing?.[key] ?? values[key]]),
      ) as PricingSettings;
      setValues(next);
      setSavedValues(next);
      setNotice("가격 설정을 저장했습니다. 운영 화면을 새로 열면 바로 적용됩니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "가격 설정을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="pricing-settings-shell">
      <header className="pricing-settings-header">
        <div>
          <p className="eyebrow">JUMPING BATTLE · SETTINGS</p>
          <h1>운영 가격 설정</h1>
          <p>고정 금액을 이 화면에서 직접 수정할 수 있습니다.</p>
        </div>
        <nav aria-label="관리자 메뉴">
          <a href="/admin">통합 운영 관리</a>
          <a href="/admin/analytics">매출 분석</a>
          <a href="/reserve" target="_blank" rel="noreferrer">고객 예약 화면</a>
          <span>{operatorName}</span>
        </nav>
      </header>

      <section className="pricing-settings-note">
        <strong>적용 기준</strong>
        <span>인원 단가는 새 예약부터 적용됩니다. 공용 부가매출과 매출 분석의 수량 금액은 저장된 최신 단가로 계산됩니다.</span>
      </section>

      <div className="pricing-settings-groups">
        {FIELD_GROUPS.map((group) => (
          <section className="pricing-settings-card" key={group.title}>
            <div className="pricing-settings-card-heading">
              <h2>{group.title}</h2>
              <p>{group.description}</p>
            </div>
            <div className="pricing-settings-fields">
              {group.fields.map((field) => (
                <label key={field.key}>
                  <span><strong>{field.label}</strong><small>{field.description}</small></span>
                  <span className="pricing-settings-input">
                    <input
                      type="number"
                      min="0"
                      max="10000000"
                      step="100"
                      value={values[field.key]}
                      onChange={(event) => changeValue(field.key, event.target.value)}
                    />
                    <b>원</b>
                  </span>
                  <em>{won(values[field.key])}원</em>
                </label>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="pricing-settings-actions">
        <div aria-live="polite">{notice || (changed ? "저장하지 않은 변경사항이 있습니다." : "현재 저장된 가격입니다.")}</div>
        <button type="button" className="secondary" disabled={!changed || saving} onClick={() => setValues(savedValues)}>변경 취소</button>
        <button type="button" disabled={!changed || saving} onClick={save}>{saving ? "저장 중…" : "가격 저장"}</button>
      </footer>
    </main>
  );
}
