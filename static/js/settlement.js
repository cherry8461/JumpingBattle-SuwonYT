(() => {
    const isValidYmd = window.isValidYmd;
    const todayYmd = window.todayYmd;
    const toNumber = window.toNumber;
    const formatMoney = window.formatMoney;
    const addDays = window.addDays;
    const timeKeyToHHMM = window.timeKeyToHHMM;
    const hhmmToTimeKey = window.hhmmToTimeKey;
    const getTimeRank = window.getTimeRank;
    const getRoomRank = window.getRoomRank;
    const formatPassSummary = window.formatPassSummary;
    const getCouponCount = window.getCouponCount;
    const parseSupplyItemInput = window.parseSupplyItemInput;
    const formatSupplyItemDisplay = window.formatSupplyItemDisplay;
    const DATE_STORAGE_KEY = 'settlementTargetDate';
    const MASTER_PASSWORD = "4357";
    const STAFF_VIEW_PASSWORD = "0308";
    
    const state = {
        targetDate: '',
        teamRows: [],
        supplyRows: [],
        cashExpenseAmount: 0,
        noShowManualCount: 0,
    };

    async function saveToGoogleSheet(payload) {
        const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzRjzX8hNfErC4qB0AD1vbwW_UQRUc09QDHsr0F1WlcTkkU_h7jkolMriQmsDJyvD8H8A/exec';
        
        await fetch(WEB_APP_URL, {
            method: 'POST',
            mode: 'no-cors', // CORS 이슈 회피용
            body: JSON.stringify(payload)
        });
    }

    let isAdminLoggedIn = false;

    document.addEventListener("DOMContentLoaded", () => {
        
        if (!window.location.pathname.includes('settlement')) {
            return; 
        }

        document.body.style.display = 'none';      

        const secureInput = document.createElement('input');
        secureInput.type = 'password'; // 👈 글자를 * 로 완벽하게 가려주는 핵심 속성
        secureInput.style.position = 'fixed';
        secureInput.style.top = '-100px'; // 화면 밖으로 숨김
        document.body.appendChild(secureInput);

        const userInput = window.prompt("🔒 [정산 보안 잠금] 비밀번호를 입력해주세요:");

        document.body.removeChild(secureInput);

        if (userInput === MASTER_PASSWORD) {
            // 처음부터 사장님 비번을 치고 들어왔다면 바로 관리자 로그인 처리
            isAdminLoggedIn = true;
            updateAuthUI();
            document.body.style.display = 'block';
        } else if (userInput === STAFF_VIEW_PASSWORD) {
            isAdminLoggedIn = false;
            updateAuthUI();
            document.body.style.display = 'block';
        } else {
            alert("❌ 접근 권한이 없습니다.");
        }
    });

    document.addEventListener("DOMContentLoaded",  () => {
        const dateInput = document.getElementById("settlementDate");
        const prevBtn = document.getElementById("prevDateBtn");
        const nextBtn = document.getElementById("nextDateBtn");
        const todayBtn = document.getElementById("todayDateBtn");
        const loadBtn = document.getElementById("loadOverviewBtn");
        const adminLoginBtn = document.getElementById("adminLoginBtn");
        const adminLogoutBtn = document.getElementById("adminLogoutBtn");

        if (dateInput && !dateInput.value) {
            dateInput.value = todayYmd();
        }

        // 🔓 [전일, 익일, 오늘] 버튼은 순정 그대로 렉 없이 날짜만 부드럽게 변경
        prevBtn?.addEventListener("click", () => { setTargetDate(addDays(readTargetDate(), -1)); });
        nextBtn?.addEventListener("click", () => { setTargetDate(addDays(readTargetDate(), 1)); });
        todayBtn?.addEventListener("click", () => { setTargetDate(todayYmd()); });

        // 🟢 [관리자 로그인] 버튼 클릭 시
        adminLoginBtn?.addEventListener("click", () => {
            const secureInput = document.createElement('input');
            secureInput.type = 'password';
            secureInput.style.position = 'fixed';
            secureInput.style.top = '-100px'; // 화면 밖으로 숨김
            document.body.appendChild(secureInput);

            const userInput = window.prompt("관리자 비밀번호를 입력해주세요.");
            document.body.removeChild(secureInput);
            
            if (userInput === MASTER_PASSWORD) {
                isAdminLoggedIn = true;
                alert("🔓 관리자 모드로 전환되었습니다. 과거 조회 및 데이터 조작이 가능합니다.");
                updateAuthUI();
            } else {
                alert("❌ 비밀번호가 일치하지 않습니다.");
            }
        });

        // 🔴 [관리자 로그아웃] 버튼 클릭 시
        adminLogoutBtn?.addEventListener("click", () => {
            isAdminLoggedIn = false;
            alert("🔒 로그아웃 되었습니다. 일반 모드로 전환됩니다.");
            setTargetDate(todayYmd()); // 날짜를 안전하게 오늘 자로 튕겨줌
            updateAuthUI();
            loadOverview().catch(e => console.error(e));
        });

        // 🎯 [조회] 버튼 클릭 시 권한 판독
        loadBtn?.addEventListener("click", () => {
            const targetDate = readTargetDate(); // 선택된 날짜
            const todayStr = todayYmd();         // 오늘 날짜

            // 🚨 관리자가 아닌데 '과거 날짜'를 조회하려고 하는 경우에만 차단!
            if (targetDate < todayStr && !isAdminLoggedIn) {
                alert("❌ 권한이 없습니다. 과거 정산 내역은 [관리자 로그인] 후 조회 가능합니다.");
                setTargetDate(todayStr); // 달력 날짜 오늘로 원복
                return;
            }

            // 오늘 정산이거나, 관리자 로그인 상태일 때는 프리패스 조회
            loadOverview().catch((e) => {
                console.error(e);
                alert('조회 실패');
            });
        });

        // 서브 기능들(행 추가 등) 바인딩 실행
        bindEvents();
    });

    function updateAuthUI() {
        const loginBtn = document.getElementById("adminLoginBtn");
        const logoutBtn = document.getElementById("adminLogoutBtn");
        const statusBadge = document.getElementById("authStatusBadge");

        if (isAdminLoggedIn) {
            if (loginBtn) loginBtn.style.display = "none";
            if (logoutBtn) logoutBtn.style.display = "inline-block";
            if (statusBadge) {
                statusBadge.innerHTML = "🛠️ 관리자 모드";
                statusBadge.style.color = "#4CAF50";
            }
        } else {
            if (loginBtn) loginBtn.style.display = "inline-block";
            if (logoutBtn) logoutBtn.style.display = "none";
            if (statusBadge) {
                statusBadge.innerHTML = "👤 일반 모드 ";
                statusBadge.style.color = "#555";
            }
        }
    }

    

    function bindEvents() {
        // ➕ 팀 행 추가 버튼
        document.getElementById('addTeamRowBtn')?.addEventListener('click', () => {
            const body = document.getElementById('teamTableBody');
            if (!body) return;
            body.appendChild(makeEditableTeamRow());
        });

        // ➕ 비품/지출 행 추가 버튼
        document.getElementById('addSupplyRowBtn')?.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/supply_history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target_date: state.targetDate })
                });
                if (res.ok) {
                    await loadOverview();
                } else {
                    alert('행 추가 실패');
                }
            } catch (e) {
                console.error(e);
                alert('행 추가 중 오류 발생');
            }
        });

        // ➕ 일괄 저장 안내 및 실행
        document.getElementById('saveSupplyAllBtn')?.addEventListener('click', () => {
            alert('이제 각 행의 [저장] 버튼을 누르면 즉시 저장됩니다.');
        });

        document.getElementById('saveSupplyAllBtn')?.addEventListener('click', () => {
            saveSupplyAll().catch((e) => {
                console.error(e);
                alert('저장 실패');
            });
        });
    }


    async function saveExcelBtn() {
        if (!isAdminLoggedIn) {
            alert("❌ 권한이 없습니다. 먼저 [관리자 로그인]을 해주세요.");
            return;
        }
        // 1. 현재 정산 페이지의 날짜 가져오기 (state.targetDate가 있다고 가정)
        const targetDate = state.targetDate; 

        if (!targetDate) {
            alert("날짜 정보가 없습니다. 정산 내역을 먼저 불러와주세요.");
            return;
        }

        // 2. 사용자 확인
        if (!confirm(`${targetDate} 정산 내역을 구글 시트에 저장하시겠습니까?`)) {
            return;
        }

        try {
            // 3. 공용 매니저 호출 (내부에서 computeTotals를 실행함)
            // 로딩 표시가 있으면 좋으니 버튼 텍스트를 잠시 바꿉니다.
            const btn = event?.target || document.querySelector('button[onclick="saveExcelBtn()"]');
            const originalText = btn.innerHTML;
            btn.innerHTML = "⏳ 저장 중...";
            btn.disabled = true;

            await window.GoogleSheetsManager.saveToSheet(targetDate);

            btn.innerHTML = originalText;
            btn.disabled = false;
            
        } catch (error) {
            console.error("구글 시트 저장 에러:", error);
            alert("저장 중 오류가 발생했습니다. 콘솔 로그를 확인해주세요.");
            
            // 버튼 복구
            const btn = document.querySelector('button[onclick="saveExcelBtn()"]');
            if(btn) {
                btn.innerHTML = "💾 엑셀저장";
                btn.disabled = false;
            }
        }
    }

    async function authAndAction(actionSuccess) {
        if (isAdminLoggedIn) {
            actionSuccess(); // 🔓 관리자 로그인 상태면 비번창 또 안 띄우고 즉시 실행!
        } else {
            // 로그인 안 되어 있으면 기습 팝업으로 방어
            const secureInput = document.createElement('input');
            secureInput.type = 'password';
            secureInput.style.position = 'fixed';
            secureInput.style.top = '-100px'; // 화면 밖으로 숨김
            document.body.appendChild(secureInput);
            const userInput = await openAuthModal("🔒 권한이 없습니다. 관리자 비밀번호를 입력해주세요:");
            document.body.removeChild(secureInput);

            if (userInput === MASTER_PASSWORD) {
                actionSuccess();
            } else {
                alert("❌ 관리자 비밀번호가 일치하지 않습니다.");
            }
        }
    }


    function getSavedTargetDate() {
        const saved = localStorage.getItem(DATE_STORAGE_KEY);
        return isValidYmd(saved) ? saved : '';
    }

    function formatPeopleSummary(row) {
        const pd = row?.payment_data || {};
        const adultCount = toNumber(pd.adultCount);
        const childCount = toNumber(pd.childCount);
        const totalFromBreakdown = adultCount + childCount;
        const totalPeople = toNumber(pd.totalPeople) || toNumber(row?.people) || totalFromBreakdown;

        if (totalFromBreakdown > 0) {
            return `${totalPeople}(${adultCount}/${childCount})`;
        }
        return totalPeople > 0 ? `${totalPeople}` : '';
    }

    function isTeamPaidRow(tr) {
        const toggle = tr?.querySelector('.team-paid-toggle');
        if (toggle) return String(toggle.dataset.paid || '0') === '1';
        if (tr?.dataset?.paid != null) return String(tr.dataset.paid) === '1';
        return !!tr?.querySelector('.team-paid')?.checked;
    }

    function setTeamPaidToggleState(toggleEl, paid, isPartyRoom = false) {
        if (!toggleEl) return;
        if (isPartyRoom) {
            toggleEl.dataset.paid = paid ? '1' : '0';
            toggleEl.textContent = '파티룸';
            toggleEl.classList.remove('is-paid', 'is-unpaid');
            toggleEl.classList.add('is-party-room');
            toggleEl.disabled = true;
            return;
        }
        const isPaid = !!paid;
        toggleEl.dataset.paid = isPaid ? '1' : '0';
        toggleEl.textContent = isPaid ? '결제' : '결제미완';
        toggleEl.disabled = false;
        toggleEl.classList.remove('is-party-room');
        toggleEl.classList.toggle('is-paid', isPaid);
        toggleEl.classList.toggle('is-unpaid', !isPaid);
    }

    function getTimeDropdownOptionsHtml() {
        const options = [];
        for (let minute = (10 * 60); minute <= (22 * 60 + 40); minute += 20) {
            const h = String(Math.floor(minute / 60)).padStart(2, '0');
            const m = String(minute % 60).padStart(2, '0');
            const hhmm = `${h}:${m}`;
            options.push(`<option value="${hhmm}">${hhmm}</option>`);
        }
        return options.join('');
    }

    function getRoomDropdownOptionsHtml() {
        return ROOM_ORDER.map((room) => `<option value="${room}">${room}</option>`).join('');
    }

    function getTimeDropdownOptionsHtmlWithSelected(selectedHHMM) {
        const selected = String(selectedHHMM || '').trim();
        const options = [];
        for (let minute = (10 * 60); minute <= (22 * 60 + 40); minute += 20) {
            const h = String(Math.floor(minute / 60)).padStart(2, '0');
            const m = String(minute % 60).padStart(2, '0');
            const hhmm = `${h}:${m}`;
            options.push(`<option value="${hhmm}" ${hhmm === selected ? 'selected' : ''}>${hhmm}</option>`);
        }
        return options.join('');
    }

    function getRoomDropdownOptionsHtmlWithSelected(selectedRoom) {
        const selected = String(selectedRoom || '').trim().toUpperCase();
        return ROOM_ORDER.map((room) => `<option value="${room}" ${room === selected ? 'selected' : ''}>${room}</option>`).join('');
    }

    function readTargetDate() {
        const dateInput = document.getElementById('settlementDate');
        return (dateInput?.value || '').trim() || todayYmd();
    }

    function setTargetDate(date) {
        const normalized = isValidYmd(date) ? date : todayYmd();
        const dateInput = document.getElementById('settlementDate');
        if (dateInput) dateInput.value = normalized;
        state.targetDate = normalized;
        localStorage.setItem(DATE_STORAGE_KEY, normalized);
    }

    async function loadOverview() {        
        const date = readTargetDate();
        setTargetDate(date);
        
        const res = await fetch(`/api/settlement/overview?date=${encodeURIComponent(date)}`);
        if (!res.ok) {
            throw new Error('정산 조회 실패');
        }
        
        const data = await res.json();

        state.teamRows = Array.isArray(data.team_rows) ? data.team_rows : [];
        state.supplyRows = Array.isArray(data.supply_rows) ? data.supply_rows.map((r) => ({
            id: r.id,
            time: r.time || '',
            item: typeof formatSupplyItemDisplay === 'function' ? formatSupplyItemDisplay(r.item || '', r.etc_text || '') : (r.item || ''),
            etc_text: r.etc_text || '',
            quantity: (r.quantity !== null && r.quantity !== undefined && r.quantity !== '') ? Number(r.quantity) : null,
            card_amount: toNumber(r.card_amount),
            cash_amount: toNumber(r.cash_amount),
            transfer_amount: toNumber(r.transfer_amount),
            total_amount: toNumber(r.total_amount),
        })) : [];

        state.cashExpenseAmount = toNumber(data?.totals?.combined?.cash_expense);
        state.noShowManualCount = toNumber(data?.totals?.combined?.no_show_count);

        renderTeamRows();
        renderSupplyRows();
        renderTotals();
    }

    function computeTotals() {
        let teamCard = 0;
        let teamCash = 0;
        let teamTransfer = 0;

        let passAdult = 0;
        let passChild = 0;
        let couponAdult = 0;
        let couponChild = 0;

        const adultUnitPrice = toNumber(document.getElementById('adultPrice')?.value) || 6000;
        const childUnitPrice = toNumber(document.getElementById('childPrice')?.value) || 4000;
       
        const teamRows = state.teamRows || []; 
        let gameCount = teamRows.length;
        let totalUsers = 0;

        teamRows.forEach((row) => {
        
            let pd = row.payment_data || {};
            if (typeof pd === 'string') {
                try { pd = JSON.parse(pd); } catch (e) { pd = {}; }
            }

            totalUsers += toNumber(pd.totalPeople || 0);

            // 결제된 항목만 합산 (필요 시 조건 추가)
            teamCard += toNumber(pd.cardInput || 0);
            teamCash += toNumber(pd.cashInput || 0);
            teamTransfer += toNumber(pd.transferInput || 0);
            
            passAdult += toNumber(pd.adultPass || 0);
            passChild += toNumber(pd.childPass || 0);
            couponAdult += toNumber(pd.couponAdult || 0);
            couponChild += toNumber(pd.couponChild || 0);
        });

        const totalPassCount = passAdult + passChild;
        const totalCouponCount = couponAdult + couponChild;
        const usageAdultAmount = (passAdult + couponAdult) * adultUnitPrice;
        const usageChildAmount = (passChild + couponChild) * childUnitPrice;
        const totalUsageAmount = usageAdultAmount + usageChildAmount;

        let supplyCard = 0;
        let supplyCash = 0;
        let supplyTransfer = 0;
        let partyRoomCardDeposit = 0, partyRoomCard = 0, partyRoomCash = 0, partyRoomTransfer = 0;
        let couponCash = 0, couponTransfer = 0;

        const supplyRows = state.supplyRows || [];

        supplyRows.forEach((row) => {
            // 공백 제거한 아이템명 확인
            const item = String(row.item || '').replace(/\s+/g, '');
            const card = toNumber(row.card_amount || 0);      // card_amount 확인
            const cash = toNumber(row.cash_amount || 0);      // cash_amount 확인
            const transfer = toNumber(row.transfer_amount || 0);

            const isPartyRoom = item.includes('파티룸');
            if (isPartyRoom) {            
                if (item.includes('(예)')) {
                    partyRoomCardDeposit += card;
                } else {
                    partyRoomCard += card;
                    partyRoomCash += cash;
                    partyRoomTransfer += transfer;
                }
            } else if (item.includes('(성)') || item.includes('(청)')) {
                couponCash += cash;
                couponTransfer += transfer;
            } else {
                supplyCard += card;
                supplyCash += cash;
                supplyTransfer += transfer;
            }
        });

        // 예약금: 팀 예약 카드의 depositPaid 항목 합산 (대시보드 전체합계와 일치)
        let depositTotal = 0;
        teamRows.forEach((row) => {
            const pd = row.payment_data || {};
            if (pd.depositPaid) {
                depositTotal += parseInt(pd.depositAmount, 10) || 5000;
            }
        });

        const teamNoShowAmount = toNumber(state.noShowManualCount) * 5000;
        const depositTotalWithTeamNoShow = depositTotal + teamNoShowAmount;

        const teamTotal = teamCard + teamCash + teamTransfer;
        const supplyTotal = supplyCard + supplyCash + supplyTransfer;
        const combinedDeposit = depositTotalWithTeamNoShow + partyRoomCardDeposit;
        const combinedCard = teamCard + supplyCard + partyRoomCard;
        const combinedCashBeforeExpense = teamCash + supplyCash;
        const cashExpense = toNumber(state.cashExpenseAmount);
        const combinedCash = combinedCashBeforeExpense - cashExpense + partyRoomCash + couponCash;
        const combinedTransfer = teamTransfer + supplyTransfer + partyRoomTransfer + couponTransfer;

        return {
            team: {
                card: teamCard,
                cash: teamCash,
                transfer: teamTransfer,
                total: teamTotal,
            },
            supply: {
                card: supplyCard,
                cash: supplyCash,
                transfer: supplyTransfer,
                total: supplyTotal,
            },
            partyroom: {
                card: partyRoomCard,
                cash: partyRoomCash,
                transfer: partyRoomTransfer,
                total: partyRoomCardDeposit + partyRoomCard + partyRoomCash + partyRoomTransfer,
            },
            coupon: {
                cash: couponCash,
                transfer: couponTransfer,
                total: couponCash + couponTransfer,
            },
            summary: {
                gameCount: gameCount,
                totalUsers: totalUsers
            },
            usageStats: {
                passCount: totalPassCount,
                couponCount: totalCouponCount,
                usageAdultAmount,
                usageChildAmount,
                totalUsageAmount,
                details: { passAdult, passChild, couponAdult, couponChild }
            },
            combined: {
                card: combinedCard,
                cash: combinedCash,
                cashExpense,
                transfer: combinedTransfer,
                deposit: depositTotalWithTeamNoShow,
                noShow: teamNoShowAmount,
                partyRoom: partyRoomCardDeposit + partyRoomCard + partyRoomCash + partyRoomTransfer,
                couponTotal: couponCash + couponTransfer,
                gameCount: gameCount,
                totalUsers: totalUsers,
                depositTotal: depositTotalWithTeamNoShow + partyRoomCardDeposit,
                total: combinedCard + combinedCash + combinedTransfer + combinedDeposit,
            }
        };
    }

    function renderTotals() {
        const totals = computeTotals();
        
        const el = document.getElementById('totalCards');
        if (!el) return;
        const { combined, team, supply, partyroom, coupon, usageStats } = totals;

        el.innerHTML = `
            <div class="settle-summary">
                <div class="settle-grand">
                    <span class="settle-summary-title">합계</span>
                    <span class="settle-summary-total">${formatMoney(combined.total)}원</span>
                    <span class="settle-summary-value">(</span>
                    <span class="settle-summary-title">N예약금</span>
                    <span class="settle-summary-value">${formatMoney(combined.depositTotal)}원</span>
                    <span class="settle-summary-line">|</span>
                    <span class="settle-summary-title">카드</span>
                    <span class="settle-summary-value">${formatMoney(combined.card)}원</span>
                    <span class="settle-summary-line">|</span>
                    <span class="settle-summary-title">현금</span>
                    <span class="settle-summary-value">${formatMoney(combined.cash)}원</span>
                    <span class="settle-summary-line">|</span>
                    <span class="settle-summary-title">계좌</span>
                    <span class="settle-summary-value">${formatMoney(combined.transfer)}원</span>
                    <span class="settle-summary-value">)</span>
                    <span class="settle-summary-value">(</span>
                    <span class="settle-summary-title">게임수</span>
                    <span class="settle-summary-value">${formatMoney(combined.gameCount)}회</span>
                    <span class="settle-summary-line">|</span>
                    <span class="settle-summary-title">이용자수</span>
                    <span class="settle-summary-value">${formatMoney(combined.totalUsers)}명</span>
                    <span class="settle-summary-value">)</span>
                </div>
                <div class="settle-breakdown">
                    <div class="settle-summary-team">
                        <div>
                            <span class="settle-summary-team-title">게임정산합계 : </span>
                            <span class="settle-summary-team-value">${formatMoney(team.card + team.cash + team.transfer + combined.deposit - combined.cashExpense)}원</span>
                            <span style="font-size:12px; color:#64748b; font-weight:bold;">   (사용된 다회/쿠폰 : ${formatMoney(usageStats.passCount)}/${formatMoney(usageStats.couponCount)} |  총 : ${formatMoney(usageStats.totalUsageAmount)}원)</span>
                        </div>
                        <div class="settle-summary-col">
                            <span class="settle-summary-title">예약금<span style="font-size:12px; color:#64748b;">(+노쇼)</span></span>
                            <span class="settle-summary-col-value">${formatMoney(combined.deposit)}원<span style="font-size:12px; color:#64748b;">(${formatMoney(combined.noShow)}원)</span></span>
                            <span class="settle-summary-title">카드</span>
                            <span class="settle-summary-col-value">${formatMoney(team.card)}원</span>
                            <span class="settle-summary-title">현금</span>
                            <span class="settle-summary-col-value">${formatMoney(team.cash)}원</span>
                            <span class="settle-summary-title">계좌</span>
                            <span class="settle-summary-col-value">${formatMoney(team.transfer)}원</span>
                            <span class="settle-summary-title">현금지출</span>
                            <span class="settle-summary-col-value">${formatMoney(combined.cashExpense)}원</span>
                        </div>
                    </div>
                    <div class="settle-summary-supply">
                        <div>
                            <span class="settle-summary-supply-title">기타판매합계 : </span>
                            <span class="settle-summary-supply-value">${formatMoney(supply.total)}원</span>
                        </div>
                        <div class="settle-summary-col">
                            <span class="settle-summary-title">카드</span>
                            <span class="settle-summary-col-value">${formatMoney(supply.card)}원</span>
                            <span class="settle-summary-title">현금</span>
                            <span class="settle-summary-col-value">${formatMoney(supply.cash)}원</span>
                            <span class="settle-summary-title">계좌</span>
                            <span class="settle-summary-col-value">${formatMoney(supply.transfer)}원</span>
                        </div>
                    </div>
                    <div class="settle-summary-supply">
                        <div>
                            <span class="settle-summary-supply-title">파티룸 합계(N예약금포함) : </span>
                            <span class="settle-summary-supply-value">${formatMoney(combined.partyRoom)}원</span>
                        </div>
                        <div class="settle-summary-col">
                            <span class="settle-summary-title">카드</span>
                            <span class="settle-summary-col-value">${formatMoney(partyroom.card)}원</span>
                            <span class="settle-summary-title">현금</span>
                            <span class="settle-summary-col-value">${formatMoney(partyroom.cash)}원</span>
                            <span class="settle-summary-title">계좌</span>
                            <span class="settle-summary-col-value">${formatMoney(partyroom.transfer)}원</span>
                        </div>
                    </div>
                    <div class="settle-summary-supply">
                        <div>
                            <span class="settle-summary-supply-title">다회권 합계 : </span>
                            <span class="settle-summary-supply-value">${formatMoney(combined.couponTotal)}원</span>
                        </div>
                        <div class="settle-summary-col">
                            <span class="settle-summary-title">현금</span>
                            <span class="settle-summary-col-value">${formatMoney(coupon.cash)}원</span>
                            <span class="settle-summary-title">계좌</span>
                            <span class="settle-summary-col-value">${formatMoney(coupon.transfer)}원</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function updateTeamRowTotal(tr) {
        if (!tr) return;
        const card = toNumber(tr.querySelector('.team-card')?.value);
        const cash = toNumber(tr.querySelector('.team-cash')?.value);
        const transfer = toNumber(tr.querySelector('.team-transfer')?.value);
        const total = card + cash + transfer;
        const totalEl = tr.querySelector('.row-total');
        if (totalEl) totalEl.textContent = formatMoney(total);
    }

    function updateSupplyRowTotal(tr) {
        if (!tr) return;
        const card = toNumber(tr.querySelector('.supply-card')?.value);
        const cash = toNumber(tr.querySelector('.supply-cash')?.value);
        const transfer = toNumber(tr.querySelector('.supply-transfer')?.value);
        const total = card + cash + transfer;
        const totalEl = tr.querySelector('.row-total');
        if (totalEl) totalEl.textContent = formatMoney(total);
    }

    function renderTeamRows() {
        const body = document.getElementById('teamTableBody');
        if (!body) return;
        body.innerHTML = '';

        const sortedRows = [...state.teamRows].sort((a, b) => {
            const timeCmp = getTimeRank(a.time_key) - getTimeRank(b.time_key);
            if (timeCmp !== 0) return timeCmp;
            const roomCmp = getRoomRank(a.room) - getRoomRank(b.room);
            if (roomCmp !== 0) return roomCmp;
            return toNumber(a.id) - toNumber(b.id);
        });

        sortedRows.forEach((row, idx) => {
            const tr = document.createElement('tr');
            tr.dataset.id = row.id;

            const pd = row?.payment_data || {};
            const adultCount = toNumber(pd.adultCount);
            const childCount = toNumber(pd.childCount);
            const totalFromBreakdown = adultCount + childCount;
            // formatPeopleSummary와 동일한 로직으로 totalPeople을 구합니다.
            const totalPeople = toNumber(pd.totalPeople) || toNumber(row?.people)|| totalFromBreakdown;

            tr.dataset.totalPeople = String(totalPeople);

            const isPartyRoom = !!(row?.payment_data?.partyRoom);
            const passSummary = formatPassSummary(row.payment_data);
            const couponCount = getCouponCount(row.payment_data);
            const peopleSummary = formatPeopleSummary(row);
            tr.dataset.paid = row.paid ? '1' : '0';
            tr.dataset.partyRoom = isPartyRoom ? '1' : '0';
            tr.dataset.cardAmount = String(toNumber(row.card_amount));
            tr.dataset.cashAmount = String(toNumber(row.cash_amount));
            tr.dataset.transferAmount = String(toNumber(row.transfer_amount));
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td>${timeKeyToHHMM(row.time_key)}</td>
                <td>${row.room || ''}</td>
                <td>${row.team || ''}</td>
                <td>${row.name || ''}</td>
                <td>${peopleSummary}</td>
                <td><span class="team-paid-chip ${isPartyRoom ? 'is-party-room' : (row.paid ? 'is-paid' : 'is-unpaid')}">${isPartyRoom ? '파티룸' : (row.paid ? '결제' : '결제미완')}</span></td>
                <td>${(row.payment_data?.depositPaid) ? formatMoney(parseInt(row.payment_data?.depositAmount, 10) || 5000) : ''}</td>
                <td>${passSummary}</td>
                <td>${couponCount > 0 ? couponCount : ''}</td>
                <td>${formatMoney(row.card_amount)}</td>
                <td>${formatMoney(row.cash_amount)}</td>
                <td>${formatMoney(row.transfer_amount)}</td>
                <td class="row-total">${formatMoney(row.total_amount)}</td>
                <td><button type="button" class="team-edit-btn">수정</button><button type="button" class="team-delete-btn">삭제</button></td>
            `;
            body.appendChild(tr);
        });

        body.querySelectorAll('.team-edit-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                // 관리자 인증 성공 시에만 실행
                authAndAction(() => {
                    const tr = btn.closest('tr');
                    if (!tr) return;
                    const id = toNumber(tr.dataset.id);
                    const row = state.teamRows.find((r) => toNumber(r.id) === id);
                    if (!row) return;
                    switchTeamRowToEditMode(tr, row);
                });
            });
        });
        body.querySelectorAll('.team-delete-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                // 관리자 인증 성공 시에만 실행
                authAndAction(() => {
                    const tr = btn.closest('tr');
                    if (!tr) return;
                    const id = toNumber(tr.dataset.id);
                    const row = state.teamRows.find((r) => toNumber(r.id) === id);
                    if (!row) return;
                    
                    // 삭제는 한 번 더 물어보는 게 안전하겠죠?
                    if (confirm("정말로 이 내역을 삭제하시겠습니까?")) {
                        deleteTeamRow(tr);
                    }
                });
            });
        });

        renderTotals();
    }

    function switchTeamRowToEditMode(tr, row) {
        const timeHHMM = timeKeyToHHMM(row.time_key) || '10:00';
        const pd = row.payment_data || {};
        const isPartyRoom = !!pd.partyRoom;
        const totalPeople = toNumber(pd.totalPeople) || toNumber(row.people);
        const adultCount = toNumber(pd.adultCount);
        const childCount = toNumber(pd.childCount);
        const depositAmount = pd.depositPaid ? (toNumber(pd.depositAmount) || 5000) : 0;
        const passAdult = toNumber(pd.adultPass);
        const passChild = toNumber(pd.childPass);
        const couponCount = getCouponCount(pd);

        tr.innerHTML = `
            <td>${tr.firstElementChild?.textContent || ''}</td>
            <td>
                <select class="team-time-input team-compact time">
                    ${getTimeDropdownOptionsHtmlWithSelected(timeHHMM)}
                </select>
            </td>
            <td>
                <select class="team-room-input team-compact room">
                    ${getRoomDropdownOptionsHtmlWithSelected(row.room || 'C1')}
                </select>
            </td>
            <td><input type="text" class="team-team-input" value="${row.team || ''}" style="width:70px"></td>
            <td><input type="text" class="team-name-input" value="${row.name || ''}" style="width:40px"></td>
            <td>
                <input type="number" class="team-total-people-input team-compact team-compact-2d" value="${totalPeople || ''}" min="0" max="99">/
                <input type="number" class="team-adult-people-input team-compact team-compact-2d" value="${adultCount || ''}" min="0" max="99">/
                <input type="number" class="team-child-people-input team-compact team-compact-2d" value="${childCount || ''}" min="0" max="99">
            </td>
            <td><button type="button" class="team-paid-toggle" data-paid="0"></button></td>
            <td><input type="number" class="team-deposit-input team-compact deposit" value="${depositAmount || ''}" min="0"></td>
            <td>
                <input type="number" class="team-pass-adult-input team-compact team-compact-2d" value="${passAdult || ''}" min="0" max="99">/
                <input type="number" class="team-pass-child-input team-compact team-compact-2d" value="${passChild || ''}" min="0" max="99">
            </td>
            <td><input type="number" class="team-coupon-input team-compact team-compact-2d" value="${couponCount || ''}" min="0" max="99"></td>
            <td><input type="number" class="money-input team-card team-compact" min="0" value="${toNumber(row.card_amount)}"></td>
            <td><input type="number" class="money-input team-cash team-compact" min="0" value="${toNumber(row.cash_amount)}"></td>
            <td><input type="number" class="money-input team-transfer team-compact" min="0" value="${toNumber(row.transfer_amount)}"></td>
            <td><input type="number" class="row-total team-compact" min="0" value="${formatMoney(row.total_amount)}"></td>
            <td><button type="button" class="team-save-btn">저장</button></td>
        `;

        const paidToggle = tr.querySelector('.team-paid-toggle');
        setTeamPaidToggleState(paidToggle, !!row.paid, isPartyRoom);
        if (!isPartyRoom) {
            paidToggle?.addEventListener('click', () => {
                const isPaid = String(paidToggle.dataset.paid || '0') === '1';
                setTeamPaidToggleState(paidToggle, !isPaid, false);
                renderTotals();
            });
        }

        tr.querySelectorAll('input').forEach((input) => {
            input.addEventListener('input', () => {
                updateTeamRowTotal(tr);
                renderTotals();
            });
            input.addEventListener('change', renderTotals);
        });

        tr.querySelector('.team-save-btn')?.addEventListener('click', async () => {
            await saveTeamRow(tr);
        });
    }

    function makeEditableTeamRow() {
        const tr = document.createElement('tr');
        tr.dataset.id = '0';

        const rowNum = document.querySelectorAll('#teamTableBody tr').length + 1;
        tr.innerHTML = `
            <td>${rowNum}</td>
            <td>
                <select class="team-time-input team-compact time">
                    ${getTimeDropdownOptionsHtml()}
                </select>
            </td>
            <td>
                <select class="team-room-input team-compact room">
                    ${getRoomDropdownOptionsHtml()}
                </select>
            </td>
            <td><input type="text" class="team-team-input" placeholder="팀명" style="width:60px"></td>
            <td><input type="text" class="team-name-input" placeholder="성함" style="width:60px"></td>
            <td>
                <input type="number" class="team-total-people-input team-compact team-compact-2d" placeholder="전" min="0" max="99">/
                <input type="number" class="team-adult-people-input team-compact team-compact-2d" placeholder="성" min="0" max="99">/
                <input type="number" class="team-child-people-input team-compact team-compact-2d" placeholder="학" min="0" max="99">
            </td>
            <td><button type="button" class="team-paid-toggle" data-paid="0"></button></td>
            <td><input type="number" class="team-deposit-input team-compact deposit" placeholder="예약금" min="0"></td>
            <td>
                <input type="number" class="team-pass-adult-input team-compact team-compact-2d" placeholder="성" min="0" max="99">/
                <input type="number" class="team-pass-child-input team-compact team-compact-2d" placeholder="학" min="0" max="99">
            </td>
            <td><input type="number" class="team-coupon-input team-compact team-compact-2d" placeholder="쿠" min="0" max="99"></td>
            <td><input class="money-input team-card" type="number" min="0" value="0"></td>
            <td><input class="money-input team-cash" type="number" min="0" value="0"></td>
            <td><input class="money-input team-transfer" type="number" min="0" value="0"></td>
            <td class="row-total">0</td>
            <td><button type="button" class="team-save-btn">저장</button></td>
        `;

        tr.querySelectorAll('input').forEach((input) => {
            input.addEventListener('input', () => {
                updateTeamRowTotal(tr);
                renderTotals();
            });
        });

        tr.querySelector('.team-save-btn').addEventListener('click', async () => {
            await saveNewTeamRow(tr);
        });

        const paidToggle = tr.querySelector('.team-paid-toggle');
        setTeamPaidToggleState(paidToggle, false);
        paidToggle?.addEventListener('click', () => {
            const isPaid = String(paidToggle.dataset.paid || '0') === '1';
            setTeamPaidToggleState(paidToggle, !isPaid);
            renderTotals();
        });

        updateTeamRowTotal(tr);
        return tr;
    }

    async function saveNewTeamRow(tr) {
        // 공통 데이터 추출 및 예외 처리
        const payload = prepareTeamPayload(tr);
        payload.booking_date = state.targetDate; // 신규 추가시에만 날짜 포함

        const res = await fetch('/api/settlement/team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        
        if (!res.ok) {
            alert('팀 행 추가 실패');
            return;
        }
        await loadOverview();
    }

    async function saveTeamRow(tr) {
        const id = toNumber(tr.dataset.id);
        if (!id) return;

        // 공통 데이터 추출 및 예외 처리
        const payload = prepareTeamPayload(tr);

        const res = await fetch(`/api/settlement/team/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        
        if (!res.ok) {
            alert('팀 정산 저장 실패');
            return;
        }
        await loadOverview();
    }

    /**
     * [추가] 행(tr)에서 데이터를 추출하여 예외 처리된 페이로드 객체를 만드는 공통 함수
     */
    function prepareTeamPayload(tr) {
        const getValue = (selector) => {
            const val = tr.querySelector(selector)?.value?.trim();
            return val === "" ? null : val; 
        };

        const getNum = (selector) => {
            return toNumber(tr.querySelector(selector)?.value) || 0;
        };

        const totalPeople = getNum('.team-total-people-input');
        const card = getNum('.team-card');
        const cash = getNum('.team-cash');
        const transfer = getNum('.team-transfer');

        // [핵심] 기존 데이터 구조와 호환되도록 필드들을 구성합니다.
        return {
            time_key: getValue('.team-time-input') ? hhmmToTimeKey(getValue('.team-time-input')) : '00-00',
            room: getValue('.team-room-input') || 'C1',
            team: getValue('.team-team-input'),
            name: getValue('.team-name-input'),
            people: totalPeople,
            total_people: totalPeople,
            adult_count: getNum('.team-adult-people-input'),
            child_count: getNum('.team-child-people-input'),
            deposit_amount: getNum('.team-deposit-input'),
            pass_adult_count: getNum('.team-pass-adult-input'),
            pass_child_count: getNum('.team-pass-child-input'),
            coupon_count: getNum('.team-coupon-input'),
            paid: isTeamPaidRow(tr) ? 1 : 0,
            card_amount: card,
            cash_amount: cash,
            transfer_amount: transfer,
            
            // --- 추가: 기존 데이터와 형식을 맞추기 위한 더미/기본 데이터 ---
            payment_data: {
                "totalPeople": totalPeople,
                "adultCount": getNum('.team-adult-people-input'),
                "childCount": getNum('.team-child-people-input'),
                "coupon": getNum('.team-coupon-input'),
                "adultPass": getNum('.team-pass-adult-input'),
                "childPass": getNum('.team-pass-child-input'),
                "isBooker": false,
                "depositPaid": getNum('.team-deposit-input') > 0,
                "depositAmount": getNum('.team-deposit-input'),
                "cardInput": card,
                "cashInput": cash,
                "transferInput": transfer,
                "finalPaymentAmount": card + cash + transfer,
                "isMatching": isTeamPaidRow(tr),
                // 기존 로직에서 에러 방지를 위한 빈 객체들
                "roomFlags": { "F": false, "S": false, "M": false, "L": false },
                "roomFlagLabel": ""
            }
        };
    }

    async function deleteTeamRow(tr) {
        const id = toNumber(tr.dataset.id);
        if (!id) return;
        
        if (!confirm("정말로 이 정산 내역을 삭제하시겠습니까?\n삭제된 데이터는 복구할 수 없습니다.")) {
            return;
        }

        try {
            const res = await fetch(`/api/settlement/team/${id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.message || '삭제 실패');
            }

            // 삭제 성공 시 목록 다시 불러오기 (자동으로 renderTeamRows가 호출됨)
            await loadOverview();
            
        } catch (error) {
            console.error("삭제 요청 중 오류:", error);
            alert("삭제에 실패했습니다: " + error.message);
        }
    }

    function renderSupplyRows() {
        const body = document.getElementById('supplyTableBody');
        if (!body) return;
        body.innerHTML = '';

        state.supplyRows.forEach((row, idx) => {
            const tr = document.createElement('tr');
            tr.dataset.id = String(toNumber(row?.id));
            tr.dataset.time = row?.time || '';
            tr.dataset.item = row?.item || '';
            tr.dataset.etcText = row?.etc_text || '';            
            tr.dataset.quantity = (row.quantity !== null && row.quantity !== undefined) ? String(row.quantity) : "";
            tr.dataset.cardAmount = String(toNumber(row?.card_amount));
            tr.dataset.cashAmount = String(toNumber(row?.cash_amount));
            tr.dataset.transferAmount = String(toNumber(row?.transfer_amount));
            
            const rawQty = row?.quantity;
            const qty = (rawQty !== null && rawQty !== undefined && rawQty !== '') ? rawQty : '-';

            tr.dataset.quantity = (rawQty !== null && rawQty !== undefined) ? String(rawQty) : "";
        
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td>${row?.time || ''}</td>
                <td>${row?.item || ''}</td>
                <td>${qty}</td>
                <td>${formatMoney(row?.card_amount || 0)}</td>
                <td>${formatMoney(row?.cash_amount || 0)}</td>
                <td>${formatMoney(row?.transfer_amount || 0)}</td>
                <td class="row-total">${formatMoney(row?.total_amount || 0)}</td>
                <td><button type="button" class="supply-edit-btn">수정</button><button type="button" class="supply-delete-btn">삭제</button></td>
            `;

            tr.querySelector('.supply-edit-btn')?.addEventListener('click', () => {
                authAndAction(() => {
                    switchSupplyRowToEditMode(tr, row, idx + 1);
                });
            });
            tr.querySelector('.supply-delete-btn')?.addEventListener('click', async () => {
                authAndAction(async () => {
                    if (confirm("정말로 이 항목을 삭제하시겠습니까?")) {
                        await deleteSupplyRow(row.id);
                    }
                });
            });

            body.appendChild(tr);
        });

        renderTotals();
    }

    function switchSupplyRowToEditMode(tr, row, rowNum) {
        const timeHHMM = timeKeyToHHMM(row.time_key) || '10:00';
        const baseItem = String(row?.item || '').trim();
        const etcText = String(row?.etc_text || '').trim();
        const itemInputValue = baseItem.replace(/\s+/g, '') === '기타' && etcText ? `${baseItem}(${etcText})` : baseItem;

        tr.innerHTML = `
            <td>${rowNum}</td>
            <td>
                <select class="supply-time" value="${row?.time || ''}">
                    ${getTimeDropdownOptionsHtmlWithSelected(timeHHMM)}
                </select>
            </td>
            <td><input type="text" class="supply-item" value="${itemInputValue}" placeholder="항목" style="width:70px"></td>
            <td><input type="number" class="supply-qty-input supply-compact-2d" value="${(row.quantity !== null && row.quantity !== undefined) ? row.quantity : ''}"></td>
            <td><input type="number" min="0" class="money-input supply-card supply-compact" value="${toNumber(row?.card_amount)}"></td>
            <td><input type="number" min="0" class="money-input supply-cash supply-compact" value="${toNumber(row?.cash_amount)}"></td>
            <td><input type="number" min="0" class="money-input supply-transfer supply-compact" value="${toNumber(row?.transfer_amount)}"></td>
            <td><input type="number" min="0" class="row-total supply-compact" value="${formatMoney(row?.total_amount || 0)}"></td>
            <td><button type="button" class="supply-save-btn">저장</button></td>
        `;

        tr.querySelectorAll('input').forEach((input) => {
            input.addEventListener('input', () => {
                updateSupplyRowTotal(tr);
                renderTotals();
            });
            input.addEventListener('change', renderTotals);
        });

        tr.querySelector('.supply-save-btn')?.addEventListener('click', async () => {
            await saveSupplyRow(tr);
        });

        updateSupplyRowTotal(tr);
    }

    async function saveSupplyRow(tr) {
        const id = toNumber(tr.dataset.id);
        if (!id) return;

        const card = toNumber(tr.querySelector('.supply-card')?.value);
        const cash = toNumber(tr.querySelector('.supply-cash')?.value);
        const transfer = toNumber(tr.querySelector('.supply-transfer')?.value);
        const qRaw = tr.querySelector('.supply-qty-input')?.value;
        const parsedItem = parseSupplyItemInput(tr.querySelector('.supply-item')?.value || '');

        const payload = {
            time: tr.querySelector('.supply-time')?.value || '',
            item: parsedItem.item || '항목',
            etc_text: parsedItem.etcText || '',
            quantity: (qRaw === "" || qRaw === undefined || qRaw === null) ? null : parseInt(qRaw, 10),
            card_amount: card,
            cash_amount: cash,
            transfer_amount: transfer
        };

        const res = await fetch(`/api/supply_history/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            await loadOverview(); // 성공 시 리로드
        } else {
            alert('저장 실패');
        }
    }

    // 2. 개별 삭제 함수
    async function deleteSupplyRow(id) {
        if (!id || id === '0') return;
        if (!confirm("이 항목을 삭제하시겠습니까?")) return;

        const res = await fetch(`/api/supply_history/${id}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            await loadOverview();
        } else {
            alert('삭제 실패');
        }
    }

    // 3. 신규 행 추가 버튼 클릭 시
    async function addNewSupplyRow() {
        const res = await fetch('/api/supply_history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_date: state.targetDate })
        });
        if (res.ok) {
            await loadOverview();
        }
    }

 

    async function init() {
        setTargetDate(getSavedTargetDate() || todayYmd());
        bindEvents();
        await loadOverview();
    }

    window.addEventListener('DOMContentLoaded', () => {
        init().catch((e) => {
            console.error(e);
            alert('정산 페이지 초기화 실패');
        });
    });

    window.computeTotals = computeTotals;
    window.saveExcelBtn = saveExcelBtn;
})();
