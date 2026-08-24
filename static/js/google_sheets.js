/**
 * google_sheets.js
 */

window.GoogleSheetsManager = {
    async saveToSheet(targetDate) {

        const computeFunc = window.computeTotals;

        if (typeof computeFunc === 'function') {
            const totals = computeFunc(); // 실행!

            const payload = {
                date: targetDate,
                totals: totals
            };
            
            // ... (fetch 로직 이하 동일) ...
        } else {
            console.error("❌ 정산 페이지가 로드되지 않았거나 함수를 찾을 수 없습니다.");
            alert("정산 화면 데이터가 로드된 상태에서만 저장이 가능합니다.");
        }
        
        let totals = {};
        if (typeof computeTotals === 'function') {
            totals = computeTotals();
        } else {
            console.error("❌ computeTotals 함수를 찾을 수 없습니다.");
            alert("정산 데이터를 계산할 수 없습니다.");
            return;
        }

        const payload = {
            date: targetDate,
            totals: totals
        };

        try {
            const response = await fetch('/api/booking/save-google-sheet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            const result = await response.json();
            if (response.ok) {
                alert("✅ 정산 저장 완료!");
            } else {
                alert("❌ 저장 실패: " + result.message);
            }
        } catch (error) {
            console.error("전송 중 오류:", error);
        }
    }
};
