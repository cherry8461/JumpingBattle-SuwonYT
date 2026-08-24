import type { Metadata } from "next";
import ReserveForm from "./ReserveForm";
import { dateInSeoul } from "../reservation-config";
import { getPricingSettings } from "@/db/pricing-settings";
import { STORE_BRAND_NAME } from "../store-profile";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `${STORE_BRAND_NAME} 오늘 입장 예약`,
  description: "직원 안내에 따라 방을 고르고 가장 빠른 시간으로 접수하는 오늘 방문 고객 전용 예약",
};

export default async function ReservePage() {
  const today = dateInSeoul();
  return <ReserveForm today={today} pricing={await getPricingSettings()} />;
}
