/**
 * 워크인 신청 및 키오스크 결제 제어 스크립트
 */
document.addEventListener("DOMContentLoaded", function () {
    const btnAction = document.getElementById("btn-action");
    const txtAction = document.getElementById("submit-text");

    // 현재 버튼의 상태를 추적하는 변수 ('SUBMIT': 신청하기, 'PAY': 결제하기)
    let currentStep = "SUBMIT"; 

    if (btnAction) {
        btnAction.addEventListener("click", function () {
            
            // --- [1단계] 신청하기 상태일 때 ---
            if (currentStep === "SUBMIT") {
                
                // 필수 입력값 및 동의 체크 검증
                if (!validateForm()) return;

                // 버튼 중복 클릭 방지
                setButtonState(true, "신청 중...");

                // 기존 walkin.js에 있던 서버 전송 로직 호출
                // 비동기 처리를 위해 기존 sendWalkInData 함수가 성공/실패를 콜백이나 Promise로 리턴해주면 좋습니다.
                // 여기서는 예시를 위해 처리 흐름을 연결해둡니다.
                executeRegistration(function (isSuccess) {
                    if (isSuccess) {
                        // 신청 성공 시 결제하기 단계로 전환
                        currentStep = "PAY";
                        setButtonState(false, "결 제 하 기");
                        btnAction.style.backgroundColor = "#ff4d4d"; // 결제 버튼 부각을 위한 색상 변경 (선택)
                    } else {
                        // 신청 실패 시 버튼 원복
                        setButtonState(false, "신 청 하 기");
                    }
                });
            } 
            // --- [2단계] 결제하기 상태일 때 ---
            else if (currentStep === "PAY") {
                
                // 1단계에서 계산된 혹은 화면에 표기된 결제 금액 가져오기
                // (금액 엘리먼트의 ID가 total-amount라고 가정)
                const amountEl = document.getElementById("total-amount");
                const amount = amountEl ? parseInt(amountEl.innerText.replace(/[^0-9]/g, ""), 10) : 0;

                if (!amount || amount <= 0) {
                    alert("결제할 금액이 올바르지 않습니다.");
                    return;
                }

                // 안드로이드 앱 인터페이스 호출
                if (window.AndroidBridge && typeof window.AndroidBridge.callPayment === "function") {
                    setButtonState(true, "결제 진행 중...");
                    window.AndroidBridge.callPayment(String(amount));
                } else {
                    alert("키오스크 결제 모듈을 호출할 수 없습니다. (안드로이드 전용)");
                }
            }
        });
    }

    // 폼 유효성 검증 함수
    function validateForm() {
        const name = document.getElementById("name").value.trim();
        const phone = document.getElementById("phone").value.trim();
        const isAgreed = document.getElementById("is_agreed").checked;

        if (!name) { alert("성함을 입력해 주세요."); return false; }
        if (!phone) { alert("전화번호를 입력해 주세요."); return false; }
        if (!isAgreed) { alert("안전 수칙 확인 및 개인정보 수집에 동의해 주세요."); return false; }
        return true;
    }

    // 버튼 활성화/비활성화 및 텍스트 변경 유틸리티
    function setButtonState(disabled, text) {
        btnAction.disabled = disabled;
        txtAction.innerText = text;
    }

    /**
     * 기존 sendWalkInData()의 핵심 역할을 하는 서버 통신 함수 예시
     * (기존 Flask와 통신하던 fetch/ajax 구문을 이 형태로 감싸주시면 됩니다)
     */
    function executeRegistration(callback) {
        const name = document.getElementById("name").value;
        const phone = document.getElementById("phone").value;
        
        // Flask 서버로 워크인 접수 데이터 전송
        fetch("/api/walkin/add", { // 실제 사용하시는 API 엔드포인트 주소로 변경하세요
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name, phone: phone })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                alert("방문자 정보 등록이 완료되었습니다. 이어서 결제를 진행해 주세요.");
                callback(true);
            } else {
                alert("등록에 실패했습니다: " + data.message);
                callback(false);
            }
        })
        .catch(err => {
            console.error(err);
            alert("서버 통신 중 오류가 발생했습니다.");
            callback(false);
        });
    }
});

/**
 * 안드로이드 네이티브가 결제 성공/실패 후 호출해 줄 전역 콜백 함수
 */
window.onPaymentResult = function (status, message) {
    const btnAction = document.getElementById("btn-action");
    const txtAction = document.getElementById("submit-text");

    if (btnAction) {
        btnAction.disabled = false;
        txtAction.innerText = "결 제 하 기"; // 상태 원복
    }

    if (status === "SUCCESS") {
        // 커스텀 모달 알림창 띄우기
        document.getElementById("modal-message").innerText = "결제 및 접수가 최종 완료되었습니다!";
        document.getElementById("custom-alert").style.display = "flex";
        
        // 결제 승인 번호 등을 서버로 보내 최종 확정 처리하는 로직을 여기에 추가할 수 있습니다.
    } else {
        alert("결제가 취소되었거나 실패했습니다.\n사유: " + message);
    }
};