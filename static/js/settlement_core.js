(() => {
    const DATE_STORAGE_KEY = 'settlementTargetDate';
    const ROOM_ORDER = ['C1', 'C2', 'B1', 'B2'];

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

    function isValidYmd(ymd) {
        return /^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''));
    }

    function getSavedTargetDate() {
        const saved = localStorage.getItem(DATE_STORAGE_KEY);
        return isValidYmd(saved) ? saved : '';
    }

    function todayYmd() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function toNumber(v) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : 0;
    }

    function formatMoney(v) {
        return toNumber(v).toLocaleString();
    }

    function formatSupplyItemDisplay(item, etcText) {
        const baseItem = String(item || '').trim();
        const extra = String(etcText || '').trim();
        const normalized = baseItem.replace(/\s+/g, '');
        if (normalized === '기타' && extra) {
            return `${baseItem}(${extra})`;
        }
        return baseItem;
    }

    function parseSupplyItemInput(rawItem) {
        const itemText = String(rawItem || '').trim();
        const match = itemText.match(/^기타\s*\((.*)\)$/);
        if (match) {
            return {
                item: '기타',
                etcText: String(match[1] || '').trim(),
            };
        }
        return {
            item: itemText,
            etcText: '',
        };
    }

    function getPassCounts(paymentData) {
        const pd = paymentData || {};
        return {
            adult: toNumber(pd.adultPass),
            child: toNumber(pd.childPass),
        };
    }

    function getCouponCount(paymentData) {
        const pd = paymentData || {};
        return toNumber(pd.couponAdult) + toNumber(pd.couponChild) + toNumber(pd.coupon);
    }

    function formatPassSummary(paymentData) {
        const pass = getPassCounts(paymentData);
        if (!pass.adult && !pass.child) return '';
        return `${pass.adult}/${pass.child}`;
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

    function addDays(ymd, delta) {
        const d = new Date(`${ymd}T00:00:00`);
        d.setDate(d.getDate() + delta);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function timeKeyToHHMM(timeKey) {
        const parts = String(timeKey || '').split('-');
        if (parts.length !== 2) return '';
        const h = String(parseInt(parts[0], 10) || 0).padStart(2, '0');
        const m = String(parseInt(parts[1], 10) || 0).padStart(2, '0');
        return `${h}:${m}`;
    }

    function hhmmToTimeKey(hhmm) {
        const parts = String(hhmm || '').split(':');
        if (parts.length !== 2) return '00-00';
        const h = String(parseInt(parts[0], 10) || 0).padStart(2, '0');
        const m = String(parseInt(parts[1], 10) || 0).padStart(2, '0');
        return `${h}-${m}`;
    }

    function getRoomRank(room) {
        const idx = ROOM_ORDER.indexOf(String(room || '').trim().toUpperCase());
        return idx >= 0 ? idx : ROOM_ORDER.length;
    }

    function getTimeRank(timeKey) {
        const parts = String(timeKey || '').split('-');
        if (parts.length !== 2) return 9999;
        const h = parseInt(parts[0], 10) || 0;
        const m = parseInt(parts[1], 10) || 0;
        return (h * 60) + m;
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

        const teamRowEls = document.querySelectorAll('#teamTableBody tr');
        teamRowEls.forEach((tr) => {
            const paid = isTeamPaidRow(tr);
            if (!paid) return;
            const cardInput = tr.querySelector('.team-card');
            const cashInput = tr.querySelector('.team-cash');
            const transferInput = tr.querySelector('.team-transfer');
            teamCard += cardInput ? toNumber(cardInput.value) : toNumber(tr.dataset.cardAmount);
            teamCash += cashInput ? toNumber(cashInput.value) : toNumber(tr.dataset.cashAmount);
            teamTransfer += transferInput ? toNumber(transferInput.value) : toNumber(tr.dataset.transferAmount);
        });

        let supplyCard = 0;
        let supplyCash = 0;
        let supplyTransfer = 0;
        let supplyDepositTotal = 0;
        let partyRoomCard = 0, partyRoomCash = 0, partyRoomTransfer = 0;
        let couponCash = 0, couponTransfer = 0;

        document.querySelectorAll('#supplyTableBody tr').forEach((tr) => {
            const hasEditor = !!tr.querySelector('.supply-item');
            const itemRaw = hasEditor
                ? String(tr.querySelector('.supply-item')?.value || '')
                : String(tr.dataset.item || '');
            const item = itemRaw.replace(/\s+/g, '');
            const card = hasEditor
                ? toNumber(tr.querySelector('.supply-card')?.value)
                : toNumber(tr.dataset.cardAmount);
            const cash = hasEditor
                ? toNumber(tr.querySelector('.supply-cash')?.value)
                : toNumber(tr.dataset.cashAmount);
            const transfer = hasEditor
                ? toNumber(tr.querySelector('.supply-transfer')?.value)
                : toNumber(tr.dataset.transferAmount);
            const amount = card + cash + transfer;

            if (item.includes('파티룸')) {
                partyRoomCard += card;
                partyRoomCash += cash;
                partyRoomTransfer += transfer;
            }

            if (item.includes('(성)') || item.includes('(청)')) {
                couponCash += cash;
                couponTransfer += transfer;
            }
            
            const isDeposit = item.includes('(예)');
            if (isDeposit) {
                supplyDepositTotal += amount;
            } else {
                supplyCard += card;
            }
            supplyCash += cash;
            supplyTransfer += transfer;
        });

        // 예약금: 팀 예약 카드의 depositPaid 항목 합산 (대시보드 전체합계와 일치)
        let depositTotal = 0;
        state.teamRows.forEach((row) => {
            const pd = row.payment_data || {};
            if (pd.depositPaid) {
                depositTotal += parseInt(pd.depositAmount, 10) || 5000;
            }
        });

        const teamNoShowAmount = toNumber(state.noShowManualCount) * 5000;
        const depositTotalWithTeamNoShow = depositTotal + teamNoShowAmount;

        const teamTotal = teamCard + teamCash + teamTransfer;
        const supplyTotal = supplyCard + supplyCash + supplyTransfer;
        const combinedCard = teamCard + supplyCard + depositTotalWithTeamNoShow;
        const combinedCashBeforeExpense = teamCash + supplyCash;
        const cashExpense = toNumber(state.cashExpenseAmount);
        const combinedCash = combinedCashBeforeExpense - cashExpense;
        const combinedTransfer = teamTransfer + supplyTransfer;

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
                total: partyRoomCard + partyRoomCash + partyRoomTransfer,
            },
            coupon: {
                cash: couponCash,
                transfer: couponTransfer,
                total: couponCash + couponTransfer,
            },
            combined: {
                card: combinedCard,
                cash: combinedCash,
                cashExpense,
                transfer: combinedTransfer,
                deposit: depositTotalWithTeamNoShow,
                partyRoom: partyRoomCard + partyRoomCash + partyRoomTransfer,
                couponTotal: couponCash + couponTransfer,
                total: combinedCard + combinedCash + combinedTransfer,
            }
        };
    }

    function renderTotals() {
        const totals = computeTotals();
        const el = document.getElementById('totalCards');
        if (!el) return;
        const { combined, team, supply, partyroom, coupon } = totals;

        el.innerHTML = `
            <div class="settle-summary">
                <div class="settle-grand">
                    <span class="settle-summary-title">합계</span>
                    <span class="settle-summary-total">${formatMoney(combined.total)}원</span>
                    <span class="settle-summary-value">(</span>
                    <span class="settle-summary-title">카드+예약금</span>
                    <span class="settle-summary-value">${formatMoney(combined.card)}원</span>
                    <span class="settle-summary-line">|</span>
                    <span class="settle-summary-title">현금</span>
                    <span class="settle-summary-value">${formatMoney(combined.cash)}원</span>
                    <span class="settle-summary-line">|</span>
                    <span class="settle-summary-title">계좌</span>
                    <span class="settle-summary-value">${formatMoney(combined.transfer)}원</span>
                    <span class="settle-summary-value">)</span>
                </div>
                <div class="settle-breakdown">
                    <div class="settle-summary-team">
                        <div>
                            <span class="settle-summary-team-title">게임정산합계 : </span>
                            <span class="settle-summary-team-value">${formatMoney(team.card + team.cash + team.transfer + combined.deposit - combined.cashExpense)}원</span>
                        </div>
                        <div class="settle-summary-col">
                            <span class="settle-summary-title">예약금<span style="font-size:12px; color:#64748b;">(취소&노쇼)</span></span>
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
                            <span class="settle-summary-supply-title">파티룸 합계 : </span>
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
                const tr = btn.closest('tr');
                if (!tr) return;
                const id = toNumber(tr.dataset.id);
                const row = state.teamRows.find((r) => toNumber(r.id) === id);
                if (!row) return;
                switchTeamRowToEditMode(tr, row);
            });
        });
        body.querySelectorAll('.team-delete-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tr = btn.closest('tr');
                if (!tr) return;
                const id = toNumber(tr.dataset.id);
                const row = state.teamRows.find((r) => toNumber(r.id) === id);
                if (!row) return;
                deleteTeamRow(tr);
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
                switchSupplyRowToEditMode(tr, row, idx + 1);
            });
            tr.querySelector('.supply-delete-btn')?.addEventListener('click', async () => {
                await deleteSupplyRow(row.id);
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


    function bindEvents() {
        document.getElementById('addTeamRowBtn')?.addEventListener('click', () => {
            const body = document.getElementById('teamTableBody');
            if (!body) return;
            body.appendChild(makeEditableTeamRow());
        });

        document.getElementById('prevDateBtn')?.addEventListener('click', () => {
            const next = addDays(readTargetDate(), -1);
            setTargetDate(next);
            loadOverview().catch((e) => {
                console.error(e);
                alert('조회 실패');
            });
        });

        document.getElementById('nextDateBtn')?.addEventListener('click', () => {
            const next = addDays(readTargetDate(), 1);
            setTargetDate(next);
            loadOverview().catch((e) => {
                console.error(e);
                alert('조회 실패');
            });
        });

        document.getElementById('todayDateBtn')?.addEventListener('click', () => {
            setTargetDate(todayYmd());
            loadOverview().catch((e) => {
                console.error(e);
                alert('조회 실패');
            });
        });

        document.getElementById('loadOverviewBtn')?.addEventListener('click', () => {
            loadOverview().catch((e) => {
                console.error(e);
                alert('조회 실패');
            });
        });

        document.getElementById('addSupplyRowBtn')?.addEventListener('click', async () => {
            try {
                // 서버에 빈 데이터 생성 요청
                const res = await fetch('/api/supply_history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target_date: state.targetDate })
                });
                
                if (res.ok) {
                    // 생성이 성공하면 데이터를 다시 불러와서(loadOverview) 
                    // 새로 생긴 빈 행을 화면에 그려줍니다.
                    await loadOverview();
                } else {
                    alert('행 추가 실패');
                }
            } catch (e) {
                console.error(e);
                alert('행 추가 중 오류 발생');
            }
        });

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
})();
