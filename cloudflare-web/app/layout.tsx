import type { Metadata } from "next";
import { STORE_BRAND_NAME } from "./store-profile";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `${STORE_BRAND_NAME} 운영`,
    description:
      `${STORE_BRAND_NAME}의 고객 예약 접수, 예약·정산 관리와 안전한 게임존 원격 운영`,
    openGraph: {
      type: "website",
      title: `${STORE_BRAND_NAME} 예약·원격 운영`,
      description: "고객 예약부터 매장 정산과 안전한 게임존 원격 제어까지",
    },
    twitter: {
      card: "summary",
      title: `${STORE_BRAND_NAME} 예약·원격 운영`,
      description: "고객 예약부터 매장 정산과 안전한 게임존 원격 제어까지",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
