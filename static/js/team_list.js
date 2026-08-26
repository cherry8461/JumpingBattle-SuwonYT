(() => {
    const DATE_STORAGE_KEY = 'teamListTargetDate';
    const ROOM_ORDER = ['C1', 'C2', 'B1', 'B2'];
    const onsetMap = { 'ㅂ':'베이직','ㅇ':'이지','ㄴ':'노멀','ㅎ':'하드','ㅊ':'챌린저','ㅋ':'키즈','ㄹ':'여름','ㅈ':'우주','ㅅ':'산타' };

    // 1. 날짜 유틸리티
    function todayYmd() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function addDays(ymd, delta) {
        const d = new Date(`${ymd}T00:00:00`);
        d.setDate(d.getDate() + delta);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function getSavedDate() {
        const saved = localStorage.getItem(DATE_STORAGE_KEY);
        return /^\d{4}-\d{2}-\d{2}$/.test(saved) ? saved : todayYmd();
    }

    function setTargetDate(date) {
        const dateInput = document.getElementById('searchDate');
        if (dateInput) dateInput.value = date;
        localStorage.setItem(DATE_STORAGE_KEY, date);
    }

    function normalizeLevelShortcut(value) {
        const raw = (value || '').trim();
        if (!raw) return '';

        const first = raw.charAt(0);
        if (onsetMap[first]) {
            return onsetMap[first];
        }
        return raw;
    }

    (function() {
        // Access is verified by the server-side team-list login.
        return;
        // 1. 비밀번호가 자동으로 가려지도록 임시 입력창(password)을 생성
        const tempInput = document.createElement('input');
        tempInput.type = 'password';
        
        // 2. 브라우저 순정 프롬프트를 띄워 안전하게 입력을 받습니다 (글자 완전 숨김)
        const userInput = window.prompt("🔒 [대시보드 보안 잠금]\n조회 권한 비밀번호를 입력해주세요.");


        if (userInput === STAFF_VIEW_PASSWORD) {
            // 비밀번호가 맞으면 아무 일 없다는 듯이 대시보드 정상 진입
            console.log("🔓 대시보드 접근 승인");
        } else {
            // 틀리거나 [취소] 누르면 칼같이 경고 후 메인이나 로그인 화면으로 퇴출
            alert("❌ 접근 권한이 없습니다.");
        }
    })();

    // [중요] 현재 어떤 탭이 활성화되어 있는지 확인하여 해당 데이터만 로드
    async function refreshActiveTabData() {
        const activeTab = document.querySelector('.tab-btn.active');
        if (!activeTab) return;

        const target = activeTab.dataset.tab;
        if (target === 'walkin-list') {
            await loadWalkinList();
        } else if (target === 'reservation-list') {
            await loadReservationList();
        } else {
            await fetchTeamList();
        }
    }

    // 2. 전체 팀 현황 로드
    async function fetchTeamList() {
        const searchDate = document.getElementById('searchDate').value;
        localStorage.setItem(DATE_STORAGE_KEY, searchDate);

        try {
            const res = await fetch(`/api/teams?date=${encodeURIComponent(searchDate)}`);
            if (!res.ok) throw new Error('조회 실패');
            const data = await res.json();

            const grouped = { C1: [], C2: [], B1: [], B2: [] };
            if (Array.isArray(data)) {
                data.forEach(item => {
                    const room = (item.room || '').toUpperCase();
                    if (grouped[room]) grouped[room].push(item);
                });
            }
            render(grouped);
        } catch (e) {
            console.error("데이터 로드 중 오류:", e);
        }
    }

    // 3. 워크인 명단 로드
    async function loadWalkinList() {
        const date = document.getElementById('searchDate').value;
        if (!date) return;

        try {
            const response = await fetch(`/api/walkin/history?date=${date}`);
            const data = await response.json();
            
            const listBody = document.getElementById('walkinListBody');
            if (!listBody) return;
            
            listBody.innerHTML = '';
            if (data.length === 0) {
                listBody.innerHTML = '<tr><td colspan="6" class="empty-row">데이터 없음</td></tr>';
                return;
            }

            data.forEach((item, index) => {
                const tr = document.createElement('tr');
                if(item.status === 'entered') {
                    tr.style.backgroundColor = '#f1f3f5';
                    tr.style.color = '#888';
                }

                // --- 방 사이즈 및 빠른방 로직 추가 ---
                // 1. DB에서 직접 가져온 라벨이 있는지 확인, 없으면 payment_data 파싱 시도
                let roomLabel = item.room_flag_label || '-';
                if (roomLabel === '-' && item.payment_data) {
                    const pData = parsePaymentDataSafe(item.payment_data);
                    roomLabel = pData?.roomFlagLabel || '-';
                }

                // 2. 'F'가 포함된 경우 빨간색 강조 스타일 적용 (선택 사항)
                let roomDisplay = roomLabel;
                if (roomLabel.startsWith('F')) {
                    roomDisplay = `<span style="color:#d32f2f; font-weight:bold;">${roomLabel}</span>`;
                }
                // ------------------------------------
                
                let level = item.level || '-';
                let autoLevel = normalizeLevelShortcut(level);
                
                tr.innerHTML = `
                    <td style="text-align: center; color: #666;">${index + 1}</td>
                    <td>${item.visit_time || '-'}</td>
                    <td><strong>${item.team || '-'}</strong></td>
                    <td>${item.name}</td>
                    <td>${item.phone || '-'}</td>
                    <td>총 ${item.people}명(성인:${item.adult_count} / 청소년:${item.child_count})</td>
                    <td>${roomDisplay}</td>
                    <td>${autoLevel}</td>
                    <td>${item.status === 'entered' ? '✅ 입장완료' : '⏳ 대기중'}</td>
                `;
                listBody.appendChild(tr);
            });
        } catch (error) {
            console.error('워크인 로드 실패:', error);
        }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[char]));
    }

    async function loadReservationList() {
        const date = document.getElementById('searchDate').value;
        const listBody = document.getElementById('reservationListBody');
        if (!date || !listBody) return;

        try {
            const response = await fetch(`/api/naver-reservations?date=${encodeURIComponent(date)}`);
            if (!response.ok) throw new Error('예약자 명단을 불러오지 못했습니다.');
            const items = await response.json();
            if (!Array.isArray(items) || items.length === 0) {
                listBody.innerHTML = '<tr><td colspan="11" class="empty-row">예약 내역이 없습니다.</td></tr>';
                return;
            }
            listBody.innerHTML = items.map(item => {
                const cancelled = item.status === 'CANCELED';
                const statusClass = cancelled ? 'is-cancelled' : (item.status === 'COMPLETED' ? 'is-completed' : 'is-confirmed');
                const canConvert = cancelled && item.handling_mode !== 'onsite_payment' && item.card_state === 'cancelled_hidden';
                const actionHtml = canConvert
                    ? `<button class="onsite-payment-btn" data-booking-id="${escapeHtml(item.booking_id)}">현장 결제 전환</button>`
                    : (item.handling_mode === 'onsite_payment' ? '<span class="onsite-payment-done">전환 완료</span>' : '-');
                return `<tr class="${cancelled ? 'reservation-cancelled' : ''}">
                    <td><span class="reservation-status ${statusClass}">${escapeHtml(item.status_label)}</span></td>
                    <td>${escapeHtml(item.time)}</td><td><strong>${escapeHtml(item.room)}</strong></td>
                    <td><strong>${escapeHtml(item.team)}</strong></td><td>${escapeHtml(item.name)}</td>
                    <td>${escapeHtml(item.phone)}</td><td>${escapeHtml(item.difficulty)}</td>
                    <td>${escapeHtml(item.people || '-')}</td><td class="reservation-product">${escapeHtml(item.product)}</td>
                    <td class="reservation-id">${escapeHtml(item.booking_id)}</td><td>${actionHtml}</td>
                </tr>`;
            }).join('');
            listBody.querySelectorAll('.onsite-payment-btn').forEach(button => {
                button.textContent = '게임카드 복구';
                button.addEventListener('click', () => recoverToOnsitePayment(button.dataset.bookingId));
            });
        } catch (error) {
            console.error('예약자 명단 로드 실패:', error);
            listBody.innerHTML = '<tr><td colspan="11" class="empty-row">예약자 명단을 불러오지 못했습니다.</td></tr>';
        }
    }

    async function recoverToOnsitePayment(bookingId) {
        if (!bookingId) return;
        const confirmed = window.confirm(
            '게임카드를 복구할까요?\n\n현장 결제 변경을 위해 직원이 취소한 경우에만 사용하세요. 카드가 다시 나타나고 당일취소 집계도 되돌립니다.'
        );
        if (!confirmed) return;
        try {
            const response = await fetch(`/api/naver-reservations/${encodeURIComponent(bookingId)}/recover-onsite-payment`, { method: 'POST' });
            const body = await response.json().catch(() => ({}));
            if (!response.ok || body.success === false) throw new Error(body.message || '처리에 실패했습니다.');
            await loadReservationList();
            alert('게임카드를 복구했습니다. 시간표를 새로고침하면 다시 보입니다.');
        } catch (error) {
            alert(error.message || '처리에 실패했습니다.');
        }
    }

    function render(grouped) {
        const container = document.getElementById('roomSections');
        if (!container) return;
        container.innerHTML = '';

        ROOM_ORDER.forEach(room => {
            const rows = grouped[room];
            const section = document.createElement('section');
            section.className = 'room-section';

            let tableHTML = `
                <h2 class="room-title">ROOM ${room}</h2>
                <table>
                    <thead>
                        <tr>
                            <th>-</th><th>팀명</th><th>이름</th><th>전화번호</th><th>인원</th><th>난이도</th><th>결제</th><th>상태</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            if (!rows || rows.length === 0) {
                tableHTML += `<tr><td colspan="6" class="empty-row">데이터 없음</td></tr>`;
            } else {
                rows.forEach((item, index) => {
                    tableHTML += `
                        <tr>
                            <td style="text-align: center; color: #666;">${index + 1}</td>
                            <td style="color: #0056b3; font-weight: bold;">${item.team || '개인'}</td>
                            <td>${item.name || '-'}</td>
                            <td>${item.phone || '-'}</td>                            
                            <td>${item.people || '0'}명</td>
                            <td>${item.level || '-'}</td>
                            <td class="${item.is_paid ? 'status-paid' : 'status-unpaid'}">
                                ${item.is_paid ? '✅결제' : '미결제'}
                            </td>
                            <td>${item.game_status || '-'}</td>
                        </tr>
                    `;
                });
            }
            tableHTML += `</tbody></table>`;
            section.innerHTML = tableHTML;
            container.appendChild(section);
        });
    }

    function init() {
        setTargetDate(getSavedDate());

        // 탭 이벤트 바인딩
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                
                btn.classList.add('active');
                document.getElementById(btn.dataset.tab).classList.add('active');

                // 탭 전환 시 즉시 해당 데이터 로드
                refreshActiveTabData();
            });
        });

        // 날짜 컨트롤 바인딩
        document.getElementById('prevDateBtn').onclick = () => {
            setTargetDate(addDays(document.getElementById('searchDate').value, -1));
            refreshActiveTabData();
        };

        document.getElementById('nextDateBtn').onclick = () => {
            setTargetDate(addDays(document.getElementById('searchDate').value, 1));
            refreshActiveTabData();
        };

        document.getElementById('todayDateBtn').onclick = () => {
            setTargetDate(todayYmd());
            refreshActiveTabData();
        };

        document.getElementById('loadBtn').onclick = refreshActiveTabData;

        // 초기 데이터 로드
        refreshActiveTabData();

        // 5초마다 현재 보고 있는 탭의 데이터만 갱신
        setInterval(refreshActiveTabData, 5000);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
