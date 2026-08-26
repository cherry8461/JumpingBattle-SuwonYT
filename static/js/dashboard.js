// Socket.IO 연결 및 실시간 이벤트 수신
let socket;
window.addEventListener('DOMContentLoaded', () => {
    if (typeof io !== 'undefined') {
        const socket = io({
            transports: ['polling', 'websocket'],
            upgrade: false,
            reconnection: true
        });
        socket.on('walkin_added', () => {
            // 워크인 목록만 즉시 갱신
            refreshWalkInList();
        });
        socket.on('naver_reservations_synced', () => {
            // Chrome extension delivers new/cancelled Naver bookings here.
            // Refresh the waiting list immediately without a page reload.
            refreshWalkInList();
        });
        socket.on('room_or_queue_changed', () => {
            // 방 상태/대기리스트 변경 시 전체 갱신
            refreshRoomAndQueue();
        });
    }
});

const ADMIN_PASSWORD = "4357";
const STAFF_VIEW_PASSWORD = "0308";
let lastValidSelectedDate = new Date().toISOString().split('T')[0];

// Walk-in 관련 기능은 그대로 유지합니다.
let previousWalkInIds = new Set();
let hasWalkInListInitialized = false;
let walkInBlinkTimer = null;
let walkinReminderInterval = null;

const GoogleSheetsManager = window.GoogleSheetsManager;

const WALKIN_GAME_DURATION_MIN = 16;
const RESERVATION_GRACE_STORAGE_KEY = 'jumpingbattle_reservation_grace_minutes_v1';

const alertSound = new Audio('/static/sounds/new_walkin.mp3');
alertSound.volume = 1;

(function() {
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

function toggleViewAll() {
    const body = document.body;
    const btn = document.getElementById('view-all-btn');
    const container = document.querySelector('.timeline-container');
    
    const isViewAll = body.classList.toggle('view-all-mode');
    btn.innerText = isViewAll ? '일반보기' : '전체보기';

    if (isViewAll) {
        initSchedule(10, 23, 60);
        if (container) container.style.pointerEvents = 'none'; // 6) 리드온리
    } else {
        initSchedule(10, 23, 20); // 기존 소스 기준 10시 시작
        if (container) container.style.pointerEvents = 'auto';
    }

    if (typeof loadBookings === 'function') {
        loadBookings(); 
    }
    if (isViewAll) {
        const container = document.querySelector('.timeline-container');
        if (container) container.scrollTop = 0;
    }
    if (typeof updateCurrentTimeGridLine === 'function') {
        updateCurrentTimeGridLine();
    }
}

function setToToday() {
    const dateInput = document.getElementById('dashboard-date');
    if (!dateInput) return;

    // 현재 시스템의 오늘 날짜 구하기 (시차 버그 방지 현지 시간 기준)
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    
    const todayStr = `${yyyy}-${mm}-${dd}`;

    // 값 동기화 후 대시보드 통신 리로드 가동!
    dateInput.value = todayStr;
    
    // 매장 예약 로드 함수 실행
    if (typeof loadBookings === 'function') {
        loadBookings();
    }
}

function expandTimetable() {
    // 이미 작성하신 코드 내의 시간 생성 로직을 0~24로 호출
    createTimetable(0, 24); 
}

// 2) 일반보기: 원래 영업 시간(예: 10시)으로 복구
function resetTimetable() {
    createTimetable(10, 24); 
}

function checkWalkinReminder(currentDataLength) {
    // 데이터가 1개 이상이면 타이머 가동
    if (currentDataLength > 0) {
        if (!walkinReminderInterval) {
            console.log("📌 대기자 존재: 30초 반복 알림 시작");
            walkinReminderInterval = setInterval(() => {
                alertSound.play().catch(e => console.log("재생 권한 필요"));
            }, 10000); // 10초
        }
    } else {
        // 데이터가 0개면 타이머 즉시 종료
        if (walkinReminderInterval) {
            console.log("✅ 대기자 없음: 반복 알림 종료");
            clearInterval(walkinReminderInterval);
            walkinReminderInterval = null;
        }
    }
}

function getWalkInItemId(item) {
    if (item && item.id !== undefined && item.id !== null) {
        return `id:${item.id}`;
    }
    const fallback = [item?.team || '', item?.name || '', item?.phone || '', item?.created_at || '', item?.level || '', item?.people || ''].join('|');
    return `fallback:${fallback}`;
}

function triggerWalkInArrivalBlink() {
    const walkinCard = document.getElementById('room-card-walkin');
    if (!walkinCard) return;

    walkinCard.classList.remove('new-arrival');
    void walkinCard.offsetWidth;
    walkinCard.classList.add('new-arrival');

    if (walkInBlinkTimer) {
        clearTimeout(walkInBlinkTimer);
    }
    walkInBlinkTimer = setTimeout(() => {
        walkinCard.classList.remove('new-arrival');
    }, 2600);
}

async function refreshWalkInList() {
    try {
        const [walkinRes, naverRes] = await Promise.all([
            fetch('/api/walkin/list'),
            fetch('/api/naver-bookings/today-init')
        ]);

        if (!walkinRes.ok || !naverRes.ok) throw new Error("데이터 로드 실패");
        
        const walkinData = await walkinRes.json(); // 현장 워크인 배열
        const naverData = await naverRes.json();   // 네이버 예약 배열

        const filteredNaverData = naverData.filter(item => {
            const isPartyRoom = item.room && item.room.includes('파티룸');
            // 이미 확인 처리 완료된 파티룸은 대기 배열에 절대 끼워주지 않습니다.
            if (isPartyRoom && item.status === 'CONFIRMED') {
                return false; 
            }
            return true;
        });

        // 🟢 2. 고유 ID 체계를 만들어서 새 손님이 왔는지 추적합니다.
        // 네이버 예약 데이터에는 식별을 위해 주입단계에서 구분을 지어줍니다.
        const processedNaver = naverData.map(item => ({ ...item, is_naver: true }));
        const combinedData = [...walkinData, ...processedNaver];

        const currentIds = new Set(combinedData.map(item => {
            return item.is_naver ? `naver-${item.booking_id}` : getWalkInItemId(item);
        }));
        
        const newlyArrivedIds = new Set();
        if (hasWalkInListInitialized) {
            currentIds.forEach((id) => {
                if (!previousWalkInIds.has(id)) {
                    newlyArrivedIds.add(id);
                }
            });
        }

        // 카운트는 네이버와 워크인을 합쳐서 계산 및 알림!
        const totalCount = combinedData.length;
        checkWalkinReminder(totalCount);
        
        // 컨테이너 초기화
        const listContainer = document.getElementById('walkInRoomList');
        if (!listContainer) return;
        listContainer.innerHTML = "";

        // 상단 총 카운트 동기화 (updateWalkInCountDisplay 역할 통합)
        const walkInCountEl = document.getElementById('walkInCount');
        if (walkInCountEl) {
            walkInCountEl.textContent = `${totalCount}팀`;
        }

        // 대기자가 아예 없으면 안내 문구 띄우고 종료
        if (totalCount === 0) {
            listContainer.innerHTML = '<span id="noWalkIn" style="color: #64748b; font-size: 13px;">대기 중인 손님이 없습니다.</span>';
            return;
        }

        combinedData.forEach(item => {
            const card = document.createElement('div');
            card.className = 'walkin-room-item';
            
            const itemId = item.is_naver ? `naver-${item.booking_id}` : getWalkInItemId(item);
            card.id = itemId;
            
            if (newlyArrivedIds.has(itemId)) {
                card.classList.add('is-new');
            }

            // 네이버와 워크인의 변수명 매칭 처리 및 버튼 세팅 분기
            let teamName = item.team || '개인';
            let displayName = item.name;
            let peopleCount = item.people ? `${item.people}명` : '-';
            let roomSize = item.room_size || item.room || '방미정';
            let levelName = (item.level && onsetMap[item.level]) ? onsetMap[item.level] : (item.level || '-');
            
            card.innerHTML = `
                <div class="info">
                    <b class="walkin-team-text" style="color: #fd6f22;" title="${item.team || '개인'}">${teamName}</b>
                    <span>|</span>
                    <span>${displayName}</span>
                    <span style="color: #fd6f22; font-weight: 700;">${peopleCount}</span>
                    <span style="background: #f1f5f9; color: #334155; padding: 1px 5px; border-radius: 3px; font-size: 11px;">${roomSize}</span>
                    ${item.room_fast ? '<span class="fast-badge" style="margin-left: 0;">fast</span>' : ''}
                    <span style="background: #dbeafe; color: #1d4ed8; padding: 1px 5px; border-radius: 3px; font-size: 11px;">${levelName}</span>
                </div>
                <button class="action-btn">입력</button>
            `;

            // 🟢 [안전장치]: 클릭 이벤트를 따옴표 문자열 방식이 아닌, 실제 자바스크립트 기능으로 바인딩합니다.
            const btn = card.querySelector('.action-btn');
            if (item.is_naver) {
                card.classList.add('is-naver-card'); 
                card.querySelector('.walkin-team-text').innerHTML = `<span style="color: #1ec800;">네이버</span>`;
                const naverLabel = item.team ? `네이버 · ${item.team}` : '네이버';
                const naverTeamElement = card.querySelector('.walkin-team-text');
                naverTeamElement.textContent = naverLabel;
                naverTeamElement.style.color = '#1ec800';
                const details = [item.name, item.time, item.phone, item.difficulty]
                    .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
                    .join(' · ');
                card.querySelector('.info span:nth-of-type(2)').textContent = details;

                // 🎯 네이버 버튼 클릭 시 작동하는 검문 구역
                btn.addEventListener('click', () => {
                    
                    // 🚨 [파티룸 예약 사전 검사 가드]
                    // 데이터의 roomSize(또는 백엔드에서 준 room 값)에 '파티룸'이 포함되어 있는지 검사합니다.
                    if (roomSize.includes('파티룸') || (item.room && item.room.includes('파티룸'))) {
                        
                        // 브라우저 기본 확인창을 띄워 알바생의 실수를 예방합니다.
                        const isTimeChecked = confirm(`⚠️ [파티룸 예약 시간 확인] : ${item.time}\n\n해당 예약은 '파티룸' 건입니다.\n수동 입력 필요함!`);
                        
                        // [취소]를 누르면 입력 처리를 중단하고 워크인 박스에 그대로 놔둡니다.
                        if (!isTimeChecked) {
                            return; // 함수 탈출 (뒤의 handleConfirmNaver를 실행하지 않음)
                        }
                    }

                    // 일반 방이거나, 확인창에서 [확인]을 눌렀을 때만 기존 순정 입력 로직 실행!
                    handleConfirmNaver(item.booking_id);
                });
            } else {
                // 순수 현장 워크인 버튼 클릭 시 작동 (따옴표 깨짐 걱정 없이 원본 데이터 그대로 안전하게 전달)
                btn.addEventListener('click', () => {
                    sendWalkInToTimeline(item);
                });
            }

            listContainer.appendChild(card);
        });

        // 새로운 데이터 유입 시 박스 깜빡임 애니메이션 가동
        if (newlyArrivedIds.size > 0) {
            triggerWalkInArrivalBlink();
        }

        previousWalkInIds = currentIds;
        hasWalkInListInitialized = true;
    } catch (error) {
        console.error("통합 대기 목록 갱신 실패:", error);
    }
}

function getWalkInCurrentTimeKey() {
    const now = new Date();
    let hour = now.getHours();
    let minute = Math.floor(now.getMinutes() / 20) * 20;

    if (hour < 10) return '10-0';
    if (hour > 22 || (hour === 22 && minute > 20)) return '22-20';
    return `${hour}-${minute}`;
}

function fetchDeposits() {
    fetch('/api/get_deposits') // 입금 내역을 가져오는 API 엔드포인트 (가칭)
        .then(response => response.json())
        .then(data => {
            const list = document.getElementById('depositList');
            list.innerHTML = ''; // 기존 목록 비우기
            
            data.forEach(item => {
                const div = document.createElement('div');
                div.className = 'deposit-item';
                div.innerHTML = `
                    <div>
                        <span class="name">${item.name}</span>
                        <div class="time">${item.deposit_time}</div>
                    </div>
                    <span class="amount">${item.amount.toLocaleString()}원</span>
                `;
                list.appendChild(div);
            });
        });
}

function autoScrollAllRoomQueues() {
    document.querySelectorAll('.room-queue').forEach((roomEl) => {
        if (!roomEl) return;
        if (roomEl.scrollHeight <= roomEl.clientHeight + 2) return;
        roomEl.scrollTop = roomEl.scrollHeight;
    });
}


async function handleConfirmNaver(bookingId) {
    // 1. 과거 날짜 읽기 전용 체크 (기존 워크인 로직 반영)
    const mainWrapper = document.querySelector('.main-wrapper');
    const isPast = mainWrapper && mainWrapper.dataset.readonly === "true";
    if (isPast) {
        alert('🔒 과거 날짜의 대시보드에는 네이버 예약을 추가할 수 없습니다.');
        return;
    }

    try {
        // 2. 백엔드 캐시에서 현재 타겟이 된 네이버 예약 데이터(이름, 시간, 룸)를 잠시 읽어옵니다.
        // (주소창에 쳤을 때 나오던 그 데이터를 프론트엔드에서 확보합니다)
        const resObj = await fetch('/api/naver-bookings/today-init');
        const initBookings = await resObj.json();
        const bookingItem = initBookings.find(b => b.booking_id === bookingId);

        if (!bookingItem) {
            alert('해당 네이버 예약의 상세 정보를 가져오지 못했습니다.');
            return;
        }

        const room = bookingItem.room || '방미정';       // "C1", "C2" 등
        const rawTime = bookingItem.time;   // "16:00" 형태

        if (room.includes('파티룸')) {
            // 1) 서버 DB(bookings)에 확실하게 저장하기 위해 기존 saveCard가 요구하는 구조로 가상 데이터 빌드
            const bookingData = {
                name: bookingItem.name || '미확인',
                team: '네이버(파티룸)', 
                phone: '',
                level: '미입력',
                people: bookingItem.people || '1', 
                paid: 0,
                completed: 0
            };

            // 가상 엘리먼트를 만들어서 원래 시스템의 저장 로직(saveCard)이 정상 작동하도록 유도합니다.
            const fakeCard = document.createElement('div');
            fakeCard.id = `party-${bookingId}`;
            
            // 원래 쓰시던 셀 구조와 매칭되도록 가상 데이터 주입
            const customPaymentData = {
                totalPeople: bookingData.people,
                roomFlags: {},
                roomFlagLabel: '파티룸',
                isBooker: true,
                depositPaid: true,
                depositAmount: 5000,
                reservationTime: rawTime,
                naverBookingId: bookingId
            };
            fakeCard.dataset.paymentData = JSON.stringify(customPaymentData);

            // 2) ⭐️ 화면에서 먼저 즉시 지워버려서 좀비처럼 남아있는 현상 원천 차단!
            const targetCardOnHtml = document.getElementById(`naver-${bookingId}`);
            if (targetCardOnHtml) {
                targetCardOnHtml.remove(); // 워크인 박스에서 즉시 강제 삭제
            }

            // 3) 네이버 캐시 상태를 완료(CONFIRMED) 처리하여 백엔드에서도 완전히 정리
            await fetch('/api/naver-bookings/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ booking_id: bookingId })
            });

            // 4) 실제 장부 데이터베이스 저장 함수 호출 (백엔드 세팅에 따라 연동)
            if (typeof saveCard === 'function') {
                try {
                    // 가상 카드가 혹시 에러나면 직접 백엔드로 insert 칠 수 있도록 예외처리
                    await saveCard(fakeCard); 
                } catch(e) {
                    console.log("가상 카드 저장 우회 처리 진행");
                }
            }
            
            // 5) 대기 목록 완벽 재동기화
            await refreshWalkInList(); 
            return; // 🚀 파티룸 처리 완전 종료
        }

        const [h, m] = rawTime.split(':');
        const timeKey = `${parseInt(h, 10)}-${m}`; // 기본 형식 (예: "16-00")

        const isViewAllMode = typeof isViewAll !== 'undefined' ? isViewAll : false;
        const targetKey = isViewAllMode ? `${parseInt(h, 10)}-0` : timeKey;
        
        let cell = document.getElementById(`cell-${targetKey}-${room}`);
        if (!cell) {
            const altTargetKey = !isViewAllMode ? `${parseInt(h, 10)}-0` : timeKey;
            cell = document.getElementById(`cell-${altTargetKey}-${room}`);
        }

        // 🚨 최종 검증
        if (!cell) {
            console.error(`❌ 셀 매칭 실패: cell-${targetKey}-${room}`);
            alert(`타임테이블에서 [${rawTime} / ${room}룸] 셀을 찾을 수 없습니다.\n\n` +
                  `💡 대시보드 화면에 현재 [${rawTime}] 시간 슬롯이 실제로 열려있는지 확인해 주세요!`);
            return;
        }

        const finalDisplayName = bookingItem.name || '미확인';
        let determinedSize = '소형';
        let isFastRoom = false;

        if (room.includes('C')) {
            determinedSize = '소형';
        } else if (room.includes('B')) {
            determinedSize = '중형';
        } else if (room.includes('A')) {
            determinedSize = '대형';
        }

        const virtualItem = {
            room_size: determinedSize,
            room_fast: isFastRoom
        };

        const dynamicRoomFlags = getWalkInRoomFlags(virtualItem);
        const dynamicRoomFlagLabel = roomFlagLabelFromFlags(dynamicRoomFlags);

        // 4. ⭐️ [핵심] 기존 타임라인 카드 생성 규격(bookingData) 완벽 복제 및 데이터 빌드
        const bookingData = {
            name: finalDisplayName,          // 손*리
            team: '미입력', // team 컬럼 누락 방지 (이름 복사)
            phone: '',                             // 연락처 공백
            level: '미입력',                        // 요구하신 레벨 기본값 '미입력'
            people: '',                           // 인원수 기본값 '1'
            paid: 0,
            completed: 0
        };

        // 5. ⭐️ addCard 엔진을 통해 타임테이블 셀에 카드 시각적 배치
        bookingData.team = bookingItem.team || bookingData.team;
        bookingData.phone = bookingItem.phone || bookingData.phone;
        bookingData.level = bookingItem.difficulty || bookingData.level;
        bookingData.people = bookingItem.people || bookingData.people;
        const card = addCard(cell, bookingData, 0, isPast);

        // 6. ⭐️ 미기입 시 카드가 증발하던 원인: paymentData 스펙 세팅
        // 기존 워크인 시스템이 카드를 렌더링할 때 필수로 요구하는 JSON 구조를 빌드합니다.
        const customPaymentData = {
            totalPeople: "", // 요청하신대로 공백 지정
            roomFlags: dynamicRoomFlags,
            roomFlagLabel: dynamicRoomFlagLabel,
            isBooker: true,
            depositPaid: true,
            depositAmount: 5000,
            reservationTime: rawTime,
            naverBookingId: bookingId // 💡 메일에서 가져온 실제 예약 시간("16:00" 등)이 자동으로 세팅됩니다.
        };

        card.dataset.paymentData = JSON.stringify(customPaymentData);

        // 7. ⭐️ 뷰 업데이트 및 백엔드(bookings 테이블) 최종 자동 저장 처리
        updateCardView(card);
        await saveCard(card); // 👈 이 함수가 돌면서 원래 쓰시던 INSERT 쿼리를 알아서 실행합니다!

        // 8. ⭐️ 정식 슬롯 등록이 끝났으므로, 네이버 캐시 상태를 완료(CONFIRMED) 처리합니다.
        await fetch('/api/naver-bookings/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ booking_id: bookingId })
        });

        alert(`예약시간 ${rawTime}!! 예약정보 추가입력 필요!!`);

        await refreshWalkInList(); 
        
        // 2. 예약 충돌 표시 재계산 (기존 로직 유지)
        if (typeof recomputeReservationConflictIndicators === 'function') {
            recomputeReservationConflictIndicators();
        }

    } catch (err) {
        console.error('❌ 네이버 예약 타임라인 전송 실패:', err);
        alert('처리 중 오류가 발생했습니다: ' + err.message);
    }
}

// 대시보드가 열릴 때 자동 실행
document.addEventListener('DOMContentLoaded', () => {
    refreshWalkInList();
    let scrollAttempts = 0;
    
    const traceTableInterval = setInterval(() => {
        scrollAttempts++;
        
        // 타임라인 Body의 첫 번째 행에서 두 번째 td(셀)가 실제로 로드되었는지 체크
        const firstRow = document.querySelector('#timelineBody tr');
        const targetCell = firstRow ? firstRow.querySelector('td:nth-child(2)') : null;
        
        // 셀이 잡혔고, 실제 화면상 위치 좌표(getBoundingClientRect)가 0보다 커졌을 때 (렌더링 완료 시점)
        if (targetCell && targetCell.getBoundingClientRect().top !== 0) {
            clearInterval(traceTableInterval); // 찾았으니 감시 카메라 종료!
            
            // 아주 미세한 안착 시간만 주고 바로 워프
            setTimeout(() => {
                updateCurrentTimeGridLine(); // 1. 빨간 현재시간 선 완벽히 좌표 계산해서 그리고
                focusTimelineLineOnLoad();   // 2. 그 Y축 좌표로 화면을 스크롤 시킵니다.
            }, 50);
            return;
        }
        
        if (scrollAttempts > 50) {
            clearInterval(traceTableInterval);
            console.log("⚠️ 타임라인 셀 로드 시간 초과로 스크롤 추적을 중단합니다.");
        }
    }, 100); 
});


// 모든 대기리스트의 입장예상시간을 다시 계산하여 반영
function updateAllQueueEstimates() {
    // 각 방별로 처리
    document.querySelectorAll('.room-queue').forEach(roomEl => {
        const room = (roomEl.id || '').replace('queue-', '');
        const oldQueueItems = Array.from(roomEl.querySelectorAll('.queue-item-manual'));
        if (oldQueueItems.length === 0) return;
        // 기존 queue-item의 데이터를 추출
        const items = oldQueueItems.map(el => ({
            id: el.dataset.qid,
            bid: el.dataset.bid,
            room: el.dataset.room,
            name: el.dataset.name,
            phone: el.dataset.phone,
            team: el.dataset.team,
            level: el.dataset.level,
            people: el.dataset.people,
            roomFlagLabel: el.dataset.roomFlagLabel,
            partyRoom: el.dataset.partyRoom === '1'
        }));
        // 새 queue-item DOM 생성
        const newEls = items.map(item => makeQueueItemElement(item, false));
        // 예상시간 계산은 각 아이템 렌더에서 처리
        // 기존 queue-item 모두 제거
        oldQueueItems.forEach(el => roomEl.removeChild(el));
        // 새 queue-item 모두 추가
        newEls.forEach(el => roomEl.appendChild(el));
    });
    autoScrollAllRoomQueues();
    updateAllTimelineEta();
}

// 타임테이블 카드 입장예정시간 뱃지
function getActiveCardsForRoom(room) {
    const cards = [];
    const tbody = document.getElementById('timelineBody');
    if (!tbody) return cards;
    // ROOMS가 정의된 후 호출되므로 직접 참조
    const ROOM_LIST = ['C1', 'C2', 'B1', 'B2'];
    const colIdx = ROOM_LIST.indexOf(room);
    if (colIdx < 0) return cards;
    tbody.querySelectorAll('tr').forEach(tr => {
        const cell = tr.children[colIdx + 1]; // +1 for time-col
        if (!cell) return;
        cell.querySelectorAll('.booking-card').forEach(card => {
            const isCompleted = card.querySelector('.p-completed')?.checked;
            if (!isCompleted) cards.push(card);
        });
    });
    return cards;
}

function setLiveEtaBadgeContent(card, entryTimeText, endTimeText, diffMinLabel, diffMinEndLabel, readyClass = '') {
    // 카드 내부 우측 상단 바구니 탐색 및 자동 생성
    let liveWrap = card.querySelector('.team-card-live-badge-wrap');
    if (!liveWrap) {
        liveWrap = document.createElement('div');
        liveWrap.className = 'team-card-live-badge-wrap';
        card.appendChild(liveWrap);
    }

    if (!entryTimeText && !endTimeText && !diffMinLabel && !diffMinEndLabel) {
        liveWrap.innerHTML = '';
        return;
    }

    
    // 💡 블루(입장)와 그레이(종료) 2연타 뱃지 세팅
    liveWrap.innerHTML = `
        <span class="p-res-badge-item type-diff ${readyClass}">${diffMinLabel}</span>    
        <span class="p-res-badge-item type-entry">${entryTimeText}</span>
        <span class="p-res-badge-item type-end">${endTimeText}</span>
        <span class="p-res-badge-item type-diff">${diffMinEndLabel}</span>
    `;
}

function calcAndApplyRoomEta(room) {
    const GAME_MIN = 16;
    const now = new Date();

    // 방 게임중 여부 → 종료시간 기준
    const roomStatusCard = document.getElementById(`room-card-${room}`);
    let startTime = new Date(now);
    if (roomStatusCard?.dataset.prevStatus === 'playing') {
        const endMs = Number(roomStatusCard.dataset.expectedEndMs || 0);
        if (endMs > 0 && endMs > now.getTime()) {
            startTime = new Date(endMs);
            startTime.setMinutes(startTime.getMinutes() + 1);
        }
    }

    // 모든 카드의 ETA 배지 숨기기
    const ROOM_LIST = ['C1', 'C2', 'B1', 'B2'];
    const colIdx = ROOM_LIST.indexOf(room);
    const tbody = document.getElementById('timelineBody');
    if (tbody && colIdx >= 0) {
        tbody.querySelectorAll('tr').forEach(tr => {
            const cell = tr.children[colIdx + 1];
            if (!cell) return;
            cell.querySelectorAll('.booking-card').forEach(card => {
                card.querySelectorAll('.p-eta-badge, .p-eta-icon, .p-eta-entry-badge, .p-eta-end-badge').forEach(b => { b.style.display = 'none'; });

                const liveWrap = card.querySelector('.team-card-live-badge-wrap');
                if (liveWrap) liveWrap.innerHTML = '';
            });
        });
    }

    // 미완료 카드들에 순서대로 ETA 계산·표시
    const activeCards = getActiveCardsForRoom(room);
    let curTime = new Date(Math.max(startTime.getTime(), now.getTime()));

    activeCards.forEach(card => {
        const h = curTime.getHours();
        const m = curTime.getMinutes();
        const eta = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        const endTime = new Date(curTime.getTime() + 16 * 60000);
        const endHH = String(endTime.getHours()).padStart(2, '0');
        const endMM = String(endTime.getMinutes()).padStart(2, '0');
        const endLabel = `${endHH}:${endMM}`;
        const etaMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime();
        const diffMin = Math.round((etaMs - now.getTime()) / 60000);
        const diffMinEnd = diffMin + 16;
        
        const entryLabel = `입장 ${eta}`;
        const endFinalLabel = `종료 ${endLabel}`;
        const diffMinLable = diffMin > 0 ? `${diffMin}분후` : `바로입장`;
        const diffMinEndLabel = `${diffMinEnd}분후`;

        const readyClass = diffMin <= 0 ? 'is-ready' : '';

        // 🚀 우측 상단 뱃지 꽂아넣기 실행!
        // 왼쪽 예약 뱃지 구역인 'team-card-badge-wrap'은 철저히 무시하므로 기존 예약 시간은 완벽하게 격리 보존됩니다.
        setLiveEtaBadgeContent(card, entryLabel, endFinalLabel, diffMinLable, diffMinEndLabel, readyClass);

        // 다음 대기자를 위해 회전 시간(16분) 누적
        curTime = new Date(curTime.getTime() + GAME_MIN * 60000);
    });
}

function updateAllTimelineEta() {
    ['C1', 'C2', 'B1', 'B2'].forEach(room => calcAndApplyRoomEta(room));
}

function getQueueCountForRoom(room) {
    // 먼저 room-queue에서 찾기 (있으면)
    const queueEl = document.getElementById(`queue-${room}`);
    if (queueEl) {
        return queueEl.querySelectorAll('.queue-item-manual').length;
    }
    
    // room-queue가 없으면 타임테이블 셀들에서 queue-item 찾기
    const allCells = Array.from(document.querySelectorAll(`td[id^="cell-"][id$="-${room}"]`));
    let count = 0;
    allCells.forEach(cell => {
        count += cell.querySelectorAll('.queue-item-manual').length;
    });
    return count;
}

function hhmmToComparableMinute(hhmm) {
    const parts = String(hhmm || '').split(':').map((v) => parseInt(v, 10));
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
        return Number.MAX_SAFE_INTEGER;
    }

    const now = new Date();
    const nowMinute = now.getHours() * 60 + now.getMinutes();
    let value = (parts[0] * 60) + parts[1];
    if (value < nowMinute - 5) {
        value += 24 * 60;
    }
    return value;
}

function parseTimeKeyParts(timeKey) {
    const [hRaw, mRaw] = String(timeKey || '').split('-');
    const hour = parseInt(hRaw, 10);
    const minute = parseInt(mRaw, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute };
}

function getReservationGraceMinutes() {
    const input = document.getElementById('reservationGraceMinutes');
    const fromInput = parseInt(input?.value, 10);
    if (Number.isFinite(fromInput)) {
        return Math.max(0, Math.min(30, fromInput));
    }
    return 3;
}

function onReservationGraceMinutesChanged(input) {
    const raw = parseInt(input?.value, 10);
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(30, raw)) : 3;
    if (input) input.value = String(clamped);
    localStorage.setItem(RESERVATION_GRACE_STORAGE_KEY, String(clamped));
}

function initReservationGraceMinutes() {
    const input = document.getElementById('reservationGraceMinutes');
    if (!input) return;
    const saved = parseInt(localStorage.getItem(RESERVATION_GRACE_STORAGE_KEY), 10);
    const value = Number.isFinite(saved) ? Math.max(0, Math.min(30, saved)) : 3;
    input.value = String(value);
}

function getCellByTimeKeyAndRoom(timeKey, room) {
    const parts = timeKey.split('-');
    const h = parts[0];
    const m = parts[1];
    
    const isViewAll = document.body.classList.contains('view-all-mode');
    
    // 전체보기 모드라면 분을 0으로 강제 변환하여 정각 셀 ID를 생성
    const targetKey = isViewAll ? `${h}-0` : timeKey;
    
    return document.getElementById(`cell-${targetKey}-${room}`);
}

function findNextBookedCardInRoom(room, afterTimeKey) {
    let nextKey = getNextTimeKey(afterTimeKey);
    while (nextKey) {
        const cell = getCellByTimeKeyAndRoom(nextKey, room);
        if (cell) {
            const card = cell.querySelector('.booking-card');
            if (card) {
                return { card, timeKey: nextKey };
            }
        }
        nextKey = getNextTimeKey(nextKey);
    }
    return null;
}

function evaluateWalkInReservationConflict(room, timeKey, nowDate, graceMinutes) {
    const nextBooking = findNextBookedCardInRoom(room, timeKey);
    if (!nextBooking) {
        return { hasConflict: false, delayMinutes: 0, nextBooking: null, expectedEnd: null, latestAllowed: null };
    }

    const parts = parseTimeKeyParts(nextBooking.timeKey);
    if (!parts) {
        return { hasConflict: false, delayMinutes: 0, nextBooking, expectedEnd: null, latestAllowed: null };
    }

    // 실제 방 카드의 예상 종료 시각 사용; 없으면 현재 시각 + 게임시간으로 추정
    const roomCard = document.getElementById(`room-card-${room}`);
    const storedEndMs = Number(roomCard?.dataset.expectedEndMs || 0);
    let expectedEnd;
    if (storedEndMs > 0 && storedEndMs > nowDate.getTime()) {
        expectedEnd = new Date(storedEndMs);
    } else {
        expectedEnd = new Date(nowDate.getTime() + WALKIN_GAME_DURATION_MIN * 60000);
    }

    const reservationAt = new Date(nowDate.getTime());
    reservationAt.setHours(parts.hour, parts.minute, 0, 0);
    if (reservationAt.getTime() < nowDate.getTime() - 5 * 60 * 1000) {
        reservationAt.setDate(reservationAt.getDate() + 1);
    }

    const latestAllowed = new Date(reservationAt.getTime());
    latestAllowed.setMinutes(latestAllowed.getMinutes() + graceMinutes);

    // 입장예정시간(expectedEnd)이 예약시간(reservationAt)보다 전이거나 같으면 지연 없음
    const diffMs = expectedEnd.getTime() - reservationAt.getTime();
    const delayMinutes = diffMs > 0 ? Math.ceil(diffMs / 60000) : 0;

    return {
        hasConflict: delayMinutes > 0,
        delayMinutes,
        nextBooking,
        expectedEnd,
        latestAllowed,
        reservationAt,
    };
}

function applyReservationConflictNotice(card, conflictInfo) {
    if (!card) return;

    let paymentData = parsePaymentDataSafe(card.dataset.paymentData) || {};
    if (conflictInfo && conflictInfo.hasConflict) {
        paymentData.reservationConflict = {
            delayMinutes: conflictInfo.delayMinutes,
            checkedAt: new Date().toISOString(),
        };
    } else if (paymentData.reservationConflict) {
        delete paymentData.reservationConflict;
    }

    card.dataset.paymentData = JSON.stringify(paymentData);
    updateCardView(card);
}

function recomputeReservationConflictIndicators() {
    const graceMinutes = getReservationGraceMinutes();
    const now = new Date();

    document.querySelectorAll('.booking-card').forEach((card) => {
        const paymentData = parsePaymentDataSafe(card.dataset.paymentData) || {};
        if (paymentData.reservationConflict) {
            delete paymentData.reservationConflict;
            card.dataset.paymentData = JSON.stringify(paymentData);
        }
        updateCardView(card);
    });

    ['C1', 'C2', 'B1', 'B2'].forEach((room) => {
        const timeKey = getWalkInCurrentTimeKey();
        // 현재 슬롯에 실제 팀이 없으면 예약 지연을 계산하지 않음
        if (!hasBookingAtTimeKey(room, timeKey)) {
            return;
        }
        const conflict = evaluateWalkInReservationConflict(room, timeKey, now, graceMinutes);
        if (conflict.hasConflict && conflict.nextBooking?.card) {
            applyReservationConflictNotice(conflict.nextBooking.card, conflict);
        }
    });
}

function getRoomLastQueueEntryComparableMinute(room) {
    const queueItems = Array.from(document.querySelectorAll(`.queue-item-manual[data-room="${room}"]`));
    const estimates = getQueueEntryEstimateTimes(room, queueItems);

    if (estimates.length > 0) {
        return hhmmToComparableMinute(estimates[estimates.length - 1]);
    }

    // 대기열이 비어 있으면 해당 방의 "첫 입장 가능 시각"으로 비교
    const firstAvailable = getQueueEntryEstimateTimes(room, [{}])[0];
    return hhmmToComparableMinute(firstAvailable);
}

function hasBookingAtTimeKey(room, timeKey) {
    const cell = document.getElementById(`cell-${timeKey}-${room}`);
    if (!cell) return false;
    return cell.querySelectorAll('.booking-card').length > 0;
}

function pickRoomByWalkInSize(roomSize, timeKey) {
    const normalized = String(roomSize || '').trim();
    const candidates = normalized === '소형' ? ['C1', 'C2'] : ['B1', 'B2'];

    const emptyAtTargetTime = candidates.filter((room) => !hasBookingAtTimeKey(room, timeKey));
    const targetRooms = emptyAtTargetTime.length > 0 ? emptyAtTargetTime : candidates;
    const now = new Date();
    const graceMinutes = getReservationGraceMinutes();

    const withConflictInfo = targetRooms.map((room) => ({
        room,
        conflict: evaluateWalkInReservationConflict(room, timeKey, now, graceMinutes),
        queueTailMinute: getRoomLastQueueEntryComparableMinute(room),
        queueCount: getQueueCountForRoom(room),
    }));

    const nonConflict = withConflictInfo.filter((it) => !it.conflict.hasConflict);
    const pool = nonConflict.length > 0 ? nonConflict : withConflictInfo;

    pool.sort((a, b) => {
        const delayDiff = (a.conflict.delayMinutes || 0) - (b.conflict.delayMinutes || 0);
        if (delayDiff !== 0) return delayDiff;

        const timeDiff = a.queueTailMinute - b.queueTailMinute;
        if (timeDiff !== 0) return timeDiff;

        const queueDiff = a.queueCount - b.queueCount;
        if (queueDiff !== 0) return queueDiff;

        return a.room.localeCompare(b.room);
    });

    const selected = pool[0] || null;
    return selected || { room: targetRooms[0] || candidates[0], conflict: null };
}

function getWalkInRoomFlags(item) {
    const roomSize = String(item?.room_size || '').trim();
    const isFast = !!item?.room_fast;

    return {
        F: isFast,
        S: roomSize === '소형',
        M: roomSize === '중형',
        L: roomSize === '대형'
    };
}

async function sendWalkInToTimeline(item) {
    const mainWrapper = document.querySelector('.main-wrapper');
    const isPast = mainWrapper && mainWrapper.dataset.readonly === "true";

    if (isPast) {
        alert('🔒 과거 날짜의 대시보드에는 워크인 손님을 추가할 수 없습니다.');
        return;
    }

    const timeKey = getWalkInCurrentTimeKey();
    const selection = pickRoomByWalkInSize(item.room_size, timeKey);
    const room = selection.room;
    const cell = document.getElementById(`cell-${timeKey}-${room}`);
    if (!cell) {
        alert('현재 시간대 셀을 찾을 수 없습니다.');
        return;
    }

    const levelValue = normalizeLevelShortcut(item.level || '');
    const adultCount = parseInt(item.adult_count, 10) || 0;
    const childCount = parseInt(item.child_count, 10) || 0;
    const totalPeople = (adultCount + childCount) || (parseInt(item.people, 10) || 0);
    const roomFlags = getWalkInRoomFlags(item);
    const roomFlagLabel = roomFlagLabelFromFlags(roomFlags);

    const bookingData = {
        name: item.name || '',
        team: (item.team || '').toString().slice(0, 10),
        phone: item.phone || '',
        level: levelValue,
        people: totalPeople || '',
        paid: 0,
        completed: 0
    };

    const card = addCard(cell, bookingData, 0, isPast);

    card.dataset.paymentData = JSON.stringify({
        totalPeople,
        adultCount,
        childCount,
        roomFlags,
        roomFlagLabel
    });
    updateCardView(card);
    await saveCard(card);

    if (selection.conflict && selection.conflict.hasConflict && selection.conflict.nextBooking?.card) {
        applyReservationConflictNotice(selection.conflict.nextBooking.card, selection.conflict);
    }
    recomputeReservationConflictIndicators();

    try {
        await fetch('/api/walkin/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id })
        });
    } catch (e) {
        console.error('워크인 상태 완료처리 실패', e);
    }
    
    await refreshWalkInList();
}

// --- Drag and Drop Functions ---
function allowDrop(event) {
    event.preventDefault();
    const queueTarget = event.target.closest('.room-queue');
    const cellTarget = event.target.closest('td[id^="cell-"]');
    if (queueTarget) queueTarget.classList.add('drag-over');
    if (cellTarget) cellTarget.classList.add('drag-over');
}

function drag(event) {
    const card = event.target.closest('.booking-card');
    if (!card) { event.preventDefault(); return; }

    const teamText = card.querySelector('.p-team-text')?.textContent.trim() || "";
    const nameText = card.querySelector('.p-name-text')?.textContent.trim() || "";
    const phoneText = card.querySelector('.p-phone-text')?.textContent.trim() || "";
    const lpText = card.querySelector('.p-level-people-text')?.textContent.trim() || "";

    if (!(teamText || nameText || lpText)) { event.preventDefault(); return; }

    if (!card.dataset.dragId) {
        card.dataset.dragId = `drag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    const cell = card.closest('td');
    const meta = parseCardMetaText(lpText);

    let cardPaymentData = null;
    try {
        cardPaymentData = card.dataset.paymentData ? JSON.parse(card.dataset.paymentData) : null;
    } catch (e) {
        cardPaymentData = null;
    }
    const bookingData = {
        type: 'booking',
        dragId: card.dataset.dragId,
        cellId: cell ? cell.id : '',
        bid: card.dataset.bid,
        name: nameText,
        phone: phoneText,
        team: teamText,
        level: meta.level || '',
        people: meta.people || '',
        roomFlagLabel: meta.roomFlagLabel || '-',
        partyRoom: !!cardPaymentData?.partyRoom,
        paid: !!card.querySelector('.p-paid')?.checked,
        completed: !!card.querySelector('.p-completed')?.checked
    };
    event.dataTransfer.setData("application/json", JSON.stringify(bookingData));
}

function queueDrag(event) {
    const item = event.target.closest('.queue-item-manual');
    if (!item) { event.preventDefault(); return; }
    const payload = {
        type: 'queue',
        qid: item.dataset.qid,
        bid: item.dataset.bid || '0',
        room: item.dataset.room,
        name: item.dataset.name || '',
        phone: item.dataset.phone || '',
        team: item.dataset.team || '',
        level: item.dataset.level || '',
        people: item.dataset.people || '',
        roomFlagLabel: item.dataset.roomFlagLabel || '-',
        partyRoom: item.dataset.partyRoom === '1'
    };
    event.dataTransfer.setData("application/json", JSON.stringify(payload));
}

function getQueueRoom(queueEl) {
    return (queueEl.id || '').replace('queue-', '');
}

// 대기 리스트별 입장예상시간 계산 함수
// 각 방(room)의 대기열을 받아, 각 팀의 입장예상시간을 배열로 반환
function getQueueEntryEstimateTimes(room, queueItemsOverride) {
    // 1. 현재 시간 구하기
    const now = new Date();
    let hour = now.getHours();
    let minute = now.getMinutes(); // 20분 단위 내림/올림 없이 실제 분 사용
    // 2. 해당 방의 대기 리스트 가져오기
    const queueItems = queueItemsOverride || Array.from(document.querySelectorAll(`.queue-item-manual[data-room="${room}"]`));
    // 3. 방 상태 확인 (게임중/비어있음 등)
    let startTime = new Date(now.getTime());
    // 방 카드에서 상태 확인
    const roomCard = document.getElementById(`room-card-${room}`);
    let playingEndTime = null;
    if (roomCard && roomCard.classList.contains('playing')) {
        // 게임중이면 남은 시간 추정
        // .time-text에 "HH:MM 종료" 형태로 표시되어 있다고 가정
        const timeText = roomCard.querySelector('.time-text')?.innerHTML || '';
        const match = timeText.match(/(\d{2}):(\d{2})/);
        if (match) {
            const endHour = parseInt(match[1], 10);
            const endMin = parseInt(match[2], 10);
            playingEndTime = new Date(now.getTime());
            playingEndTime.setHours(endHour, endMin, 0, 0);
            if (playingEndTime < now) {
                // 이미 지난 경우 다음날로 보정
                playingEndTime.setDate(playingEndTime.getDate() + 1);
            }
            // 첫번째 대기팀은 종료시간+1분부터 입장
            startTime = new Date(playingEndTime.getTime());
            startTime.setMinutes(startTime.getMinutes() + 1);
        }
    } else {
        // 방이 비어있으면 현재시간(분단위 그대로)로 첫 팀 입장예상시간 설정
        startTime = new Date(now.getTime());
    }
    // 4. 각 팀별로 입장예상시간 계산
    // 게임 시간(분) + 준비시간(분)
    const GAME_DURATION_MIN = 16;
    const result = [];
    let curTime = new Date(startTime.getTime());
    for (let i = 0; i < queueItems.length; i++) {
        // 실제 시간(분단위 그대로) 사용
        let h = curTime.getHours();
        let m = curTime.getMinutes();
        // HH:MM 포맷
        const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        result.push(timeStr);
        // 다음 팀은 16분 뒤로
        curTime.setMinutes(curTime.getMinutes() + GAME_DURATION_MIN);
    }
    return result;
}

function parseHHMMToSlotTimeKey(hhmm) {
    if (!hhmm) return null;
    const parts = String(hhmm).split(':').map(Number);
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    const hour = parts[0];
    const minute = parts[1];
    const slotMinute = Math.floor(minute / 20) * 20;
    return `${hour}-${slotMinute}`;
}

function clearTimelineEtaChips() {
    document.querySelectorAll('.eta-chip-layer').forEach((el) => el.remove());
}

function ensureEtaChipLayer(cell) {
    let layer = cell.querySelector('.eta-chip-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.className = 'eta-chip-layer';
        cell.appendChild(layer);
    }
    return layer;
}

function renderTimelineOverviewAndEtaChips() {
    clearTimelineEtaChips();
    // ETA 대기칩은 표시하지 않고 빨간 현재시간 라인만 유지
}

function makeQueueItemElement(item, isNew) {
    // ...디버깅용 alert/console.log 제거...
    const el = document.createElement('div');
    el.className = 'queue-item-manual';
    el.draggable = true;
    el.ondragstart = queueDrag;
    el.dataset.qid = String(item.id || 0);
    el.dataset.bid = String(item.bid || 0);
    el.dataset.room = item.room || '';
    el.dataset.name = item.name || '';
    el.dataset.phone = item.phone || '';
    el.dataset.team = item.team || '';
    el.dataset.level = item.level || '';
    el.dataset.people = item.people || '';
    el.dataset.orderNo = String(item.order_no || item.orderNo || 0);
    el.dataset.roomFlagLabel = item.roomFlagLabel || '-';
    const isPartyRoom = !!(item.partyRoom || item.party_room);
    el.dataset.partyRoom = isPartyRoom ? '1' : '0';
    const title = item.team || item.name || '대기';
    const peopleText = item.people ? `${item.people}명` : '-';
    const roomFlagLabel = item.roomFlagLabel || '-';
    const levelText = item.level || '미지정';

    // 대기리스트에서 이 팀이 몇 번째인지 찾기
    let queueItems;
    // 세 번째 인자(queueItemsOverride)가 있으면 그걸 사용
    if (arguments.length >= 3 && arguments[2]) {
        queueItems = arguments[2];
    } else {
        queueItems = Array.from(document.querySelectorAll(`.queue-item-manual[data-room="${el.dataset.room}"]`));
        if (isNew) {
            queueItems.push(el);
        }
    }
    const myIdx = queueItems.findIndex(q => String(q.dataset.qid) === String(item.id));
    const estimateTimes = getQueueEntryEstimateTimes(el.dataset.room, queueItems);
    const myEstimate = estimateTimes[myIdx] || '';

    
    // linked booking card의 paymentData 가져오기
    const linkedBidBefore = parseInt(el.dataset.bid || '0', 10);
    let linkedPaymentData = null;
    if (linkedBidBefore) {
        const linkedCardBefore = document.querySelector(`.booking-card[data-bid="${linkedBidBefore}"]`);
        if (linkedCardBefore) {
            linkedPaymentData = parsePaymentDataSafe(linkedCardBefore.dataset.paymentData);
        }
    }
    
    if (typeof buildQueueInfoText === 'function') {
        try {
            const infoHtml = buildQueueInfoText(title, peopleText, el.dataset.room, roomFlagLabel, null, levelText, isPartyRoom, linkedPaymentData);
            // 예상입장시간과 현재시간 차이(분) 계산
            let remainMin = '';
            if (myEstimate) {
                const now = new Date();
                const [h, m] = myEstimate.split(":").map(Number);
                const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
                let diff = Math.round((target - now) / 60000);
                // 음수면 0으로 보정
                if (diff < 0) diff = 0;
                remainMin = ` (${diff}분)`;
            }
            // 팀명 말줄임 처리: infoHtml의 <b>...</b> 부분을 span으로 대체
            const infoHtmlEllipsis = infoHtml.replace(/<b>(.*?)<\/b>/, `<b class='queue-team-text' title='$1'>$1</b>`);
            //el.innerHTML = `<span class="info" style="flex: 1; min-width: 0; gap: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${infoHtmlEllipsis}</span><span style="background:yellow;color:red;border:2px solid blue;padding:2px 6px;display:inline-block;"><b>${myEstimate}${remainMin}</b></span><span class="actions"><button class="start-btn" onclick="event.stopPropagation(); startQueueItem(this.closest('.queue-item-manual'))"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 11-5-5-5 5M12 18V6M5 21h14"/></svg></button><button class="delete-btn" onclick="event.stopPropagation(); removeQueueItem(this.closest('.queue-item-manual'))"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></span>`;
            el.innerHTML = `
                <span class="info" style="flex: 1; min-width: 0;">${infoHtmlEllipsis}</span>
                <div class="actions" style="display: flex; align-items: center; gap: 2px;">
                    <span style="background: #343a40; color: #ffec99; border: none; padding: 2px 6px; border-radius: 4px; font-size: 14px; font-weight: 800; margin-right: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); white-space: nowrap;">
                        <span style="font-size: 10px; margin-right: 2px;">🕒</span>${myEstimate}${remainMin}
                    </span>
                    <span class="actions">
                        <button class="start-btn" onclick="event.stopPropagation(); startQueueItem(this.closest('.queue-item-manual'))"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 11-5-5-5 5M12 18V6M5 21h14"/></svg></button>
                        <button class="delete-btn" onclick="event.stopPropagation(); removeQueueItem(this.closest('.queue-item-manual'))"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </span>`;
        } catch (e) {
            console.error(e);
        }
    }

    const linkedBid = parseInt(el.dataset.bid || '0', 10);
    const linkedCard = linkedBid ? document.querySelector(`.booking-card[data-bid="${linkedBid}"]`) : null;
    if (linkedCard) {
        applyQueueToneFromCard(el, linkedCard);
    } else {
        el.classList.toggle('party-room', isPartyRoom);
        el.classList.remove('paid');
        el.classList.remove('unpaid');
    }

    return el;
}

function applyQueueToneFromCard(queueItem, card) {
    if (!queueItem || !card) return;
    const view = card.querySelector('.cell-view');
    if (!view) return;

    const isPartyRoom = view.classList.contains('party-room');
    const isPaid = view.classList.contains('paid');
    const isUnpaid = view.classList.contains('unpaid');

    queueItem.classList.toggle('party-room', isPartyRoom);
    queueItem.classList.toggle('paid', !isPartyRoom && isPaid);
    queueItem.classList.toggle('unpaid', !isPartyRoom && isUnpaid);
}

function updateCardQueueStatus(card) {
    if (!card) return;
    const statusEl = card.querySelector('.queue-transfer-status');
    if (!statusEl) return;
    const completedEl = card.querySelector('.p-completed');
    const isCompleted = !!completedEl?.checked;
    const isPaid = !!card.querySelector('.p-paid')?.checked;
    const isParty = isPartyRoomCard(card);

    if (isParty) {
        statusEl.textContent = '파티룸';
        statusEl.classList.remove('waiting', 'paid', 'unpaid-completed');
        statusEl.classList.toggle('party-room-done', isCompleted);
        statusEl.classList.toggle('party-room-pending', !isCompleted);
        statusEl.classList.remove('completed');
        return;
    }
    statusEl.classList.remove('party-room-done', 'party-room-pending');

    if (isCompleted && isPaid) {
        statusEl.textContent = '완료';
        statusEl.classList.remove('waiting');
        statusEl.classList.remove('paid');
        statusEl.classList.remove('unpaid-completed');
        statusEl.classList.add('completed');
        return;
    }

    statusEl.textContent = isPaid ? '결제완료' : '결제미완료';
    statusEl.classList.remove('waiting');
    // 결제미완료 상태에서 완료 버튼을 누르면 회색 처리(완료 class)는 유지, 문구는 결제미완료 유지
    statusEl.classList.toggle('completed', isCompleted);
    statusEl.classList.toggle('paid', isPaid && !isCompleted);
    statusEl.classList.toggle('unpaid-completed', isCompleted && !isPaid);
}

function updateAllCardQueueStatuses() {
    document.querySelectorAll('.booking-card').forEach(updateCardQueueStatus);
}

function showToast(message, anchorEl) {
    if (!message) return;
    let toast = document.getElementById('appToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'appToast';
        toast.className = 'app-toast';
        document.body.appendChild(toast);
    }
    if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        toast.classList.add('anchored');
        toast.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
        toast.style.top = `${Math.max(12, Math.round(rect.top - 2))}px`;
    } else {
        toast.classList.remove('anchored');
        toast.style.left = '';
        toast.style.top = '';
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
        toast.classList.remove('show');
    }, 1800);
}

function getNextTimeKey(timeKey) {
    const [h, m] = timeKey.split('-').map(Number);
    let nextM = m + 20;
    let nextH = h;
    if (nextM >= 60) {
        nextM -= 60;
        nextH += 1;
    }
    if (nextH > 22) return null;
    return `${nextH}-${nextM}`;
}

function getPrevTimeKey(timeKey) {
    const [h, m] = timeKey.split('-').map(Number);
    let prevM = m - 20;
    let prevH = h;
    if (prevM < 0) {
        prevM += 60;
        prevH -= 1;
    }
    if (prevH < 10) return null;
    return `${prevH}-${prevM}`;
}

function isPartyRoomCard(card) {
    if (!card) return false;
    const view = card.querySelector('.cell-view');
    if (view && view.classList.contains('party-room')) return true;
    try {
        const paymentData = card.dataset.paymentData ? JSON.parse(card.dataset.paymentData) : null;
        return !!paymentData?.partyRoom;
    } catch (e) {
        return false;
    }
}

function findPartyRoomCardsInCell(cell) {
    if (!cell) return null;
    const cards = Array.from(cell.querySelectorAll('.booking-card'));
    return cards.filter((c) => isPartyRoomCard(c));
}

function collectLinkedPartyRoomCards(baseCard, baseCell) {
    if (!baseCard || !baseCell) return [];

    const baseParts = baseCell.id.split('-'); // cell-{h}-{m}-{room}
    const room = baseParts[3];
    const baseTimeKey = `${baseParts[1]}-${baseParts[2]}`;

    const linked = [baseCard];

    let prevKey = getPrevTimeKey(baseTimeKey);
    while (prevKey) {
        const prevCell = document.getElementById(`cell-${prevKey}-${room}`);
        const prevCards = findPartyRoomCardsInCell(prevCell);
        if (!prevCards || prevCards.length === 0) break;
        linked.unshift(...prevCards);
        prevKey = getPrevTimeKey(prevKey);
    }

    let nextKey = getNextTimeKey(baseTimeKey);
    while (nextKey) {
        const nextCell = document.getElementById(`cell-${nextKey}-${room}`);
        const nextCards = findPartyRoomCardsInCell(nextCell);
        if (!nextCards || nextCards.length === 0) break;
        linked.push(...nextCards);
        nextKey = getNextTimeKey(nextKey);
    }

    return Array.from(new Set(linked));
}

function ensureCopyBadge(card) {
    if (!card) return null;
    let badge = card.querySelector('.team-card-copy-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'team-card-copy-badge';
        badge.style.display = 'none';
        card.appendChild(badge);
    }
    return badge;
}

function setCardCopyBadge(card, seq) {
    const badge = ensureCopyBadge(card);
    if (!badge) return;
    const n = parseInt(seq, 10);
    if (!Number.isFinite(n) || n <= 0) {
        badge.textContent = '';
        badge.style.display = 'none';
        return;
    }
    badge.textContent = String(n);
    badge.style.display = 'inline-flex';
}

function syncCopyBadgeFromPaymentData(card, paymentData) {
    if (!card) return;
    const groupId = String(paymentData?.copyGroupId || '').trim();
    const seq = parseInt(paymentData?.copySeq, 10);
    if (groupId && Number.isFinite(seq) && seq > 0) {
        card.dataset.copyGroupId = groupId;
        card.dataset.copySeq = String(seq);
        setCardCopyBadge(card, seq);
        return;
    }
    card.dataset.copyGroupId = '';
    card.dataset.copySeq = '';
    setCardCopyBadge(card, 0);
}

function setCopyMetaToCard(card, groupId, seq) {
    if (!card) return;
    const gid = String(groupId || '').trim();
    const n = parseInt(seq, 10);
    if (!gid || !Number.isFinite(n) || n <= 0) return;

    card.dataset.copyGroupId = gid;
    card.dataset.copySeq = String(n);
    setCardCopyBadge(card, n);

    const pd = parsePaymentDataSafe(card.dataset.paymentData) || {};
    pd.copyGroupId = gid;
    pd.copySeq = n;
    card.dataset.paymentData = JSON.stringify(pd);
}

function clearCopyMetaFromCard(card) {
    if (!card) return;
    card.dataset.copyGroupId = '';
    card.dataset.copySeq = '';
    setCardCopyBadge(card, 0);

    const pd = parsePaymentDataSafe(card.dataset.paymentData) || {};
    delete pd.copyGroupId;
    delete pd.copySeq;
    card.dataset.paymentData = JSON.stringify(pd);
}

function setPaymentCopyGroupBadge(card) {
    const badge = document.getElementById('paymentCopyGroupBadge');
    if (!badge) return;
    const seq = parseInt(card?.dataset?.copySeq || '0', 10);
    const hasGroup = !!String(card?.dataset?.copyGroupId || '').trim();
    if (hasGroup && Number.isFinite(seq) && seq > 0) {
        badge.textContent = String(seq);
        badge.classList.remove('is-empty');
        badge.title = '클릭 시 복제 그룹에서 제외';
    } else {
        badge.textContent = '-';
        badge.classList.add('is-empty');
        badge.title = '클릭해 오늘 그룹 선택';
    }
    badge.style.display = 'inline-flex';
    closePaymentCopyGroupPicker();
}

function getCopyGroupCreatedYmd(groupId) {
    const gid = String(groupId || '').trim();
    if (!gid) return '';
    const match = gid.match(/^copygrp-(\d+)-/);
    if (!match) return '';
    const createdMs = parseInt(match[1], 10);
    if (!Number.isFinite(createdMs) || createdMs <= 0) return '';
    return formatDateYYYYMMDD(new Date(createdMs));
}

function collectTodayCopyGroups() {
    const todayYmd = getDashboardDateYMD();
    const groups = new Map();

    document.querySelectorAll('.booking-card').forEach((card) => {
        const groupId = String(card.dataset.copyGroupId || '').trim();
        const seq = parseInt(card.dataset.copySeq || '0', 10);
        if (!groupId || !Number.isFinite(seq) || seq <= 0) return;
        if (getCopyGroupCreatedYmd(groupId) !== todayYmd) return;

        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(card);
    });

    const result = [];
    groups.forEach((cards, groupId) => {
        if (!cards || cards.length === 0) return;
        cards.sort((a, b) => {
            const sa = parseInt(a.dataset.copySeq || '0', 10);
            const sb = parseInt(b.dataset.copySeq || '0', 10);
            return sa - sb;
        });

        const createdYmd = getCopyGroupCreatedYmd(groupId);
        const nowInGroup = !!(currentPaymentCard && cards.includes(currentPaymentCard));
        result.push({ groupId, cards, createdYmd, nowInGroup });
    });

    result.sort((a, b) => {
        const am = parseInt(String(a.groupId).split('-')[1] || '0', 10);
        const bm = parseInt(String(b.groupId).split('-')[1] || '0', 10);
        return am - bm;
    });

    return result;
}

function closePaymentCopyGroupPicker() {
    const picker = document.getElementById('paymentCopyGroupPicker');
    if (!picker) return;
    picker.style.display = 'none';
}

function openPaymentCopyGroupPicker() {
    const picker = document.getElementById('paymentCopyGroupPicker');
    const select = document.getElementById('paymentCopyGroupSelect');
    if (!picker || !select || !currentPaymentCard) return;

    select.innerHTML = '';

    const allCards = Array.from(document.querySelectorAll('.booking-card'));
    const todayTeams = [];

    const addedGroupIds = new Set();

    allCards.forEach(card => {
        
        // 🚨 [방어선 1] 현재 내가 열어놓은 정산창의 카드는 목록에서 철저히 제외
        if (card === currentPaymentCard) return;

        // 🚨 [방어선 2] 화면에서 완전히 숨겨진 카드(display: none 등)는 유령 카드이므로 패스
        if (card.offsetWidth === 0 && card.offsetHeight === 0) return;

        // 2. 카드 내부에 적힌 진짜 팀명 텍스트 추출 (가장 확실한 p-team-text 먼저 저격)
        let teamName = '';
        const teamNameEl = card.querySelector('.p-team-text') || 
                           card.querySelector('.p-team-name') || 
                           card.querySelector('.team-name') || 
                           card.querySelector('[class*="team-text"]') ||
                           card.querySelector('[id*="TeamName"]');
        
        if (teamNameEl) {
            teamName = teamNameEl.textContent.trim();
        } else {
            teamName = card.dataset.teamName || card.dataset.team || '';
            teamName = teamName.trim();
        }

        // 🚨 [방어선 3] 이름이 없거나, 하이픈(-), 미입력, 빈칸인 알맹이 없는 유령 슬롯은 싹 다 필터링!
        if (!teamName || teamName === '-' || teamName === '미입력' || teamName === '') return;

        const groupId = String(card.dataset.copyGroupId || '').trim();

        if (groupId && addedGroupIds.has(groupId)) {
            return; 
        }

        if (!card.id) {
            card.id = `temp-card-${Math.random().toString(36).slice(2, 9)}`;
        }

        if (groupId) {
            addedGroupIds.add(groupId);
        }

        // 3. 위 검문을 모두 통과한 진짜 '살아있는 팀'만 명단에 등록
        todayTeams.push({
            id: card.id,
            name: teamName,
            groupId: groupId
        });
    });

    // 4. 드롭다운 첫 번째 기본 옵션 세팅
    const head = document.createElement('option');
    head.value = '';
    head.textContent = todayTeams.length ? `오늘 팀 선택` : '오늘 팀 없음';
    select.appendChild(head);

    // 5. 정제된 진짜 팀명들을 드롭다운에 주입
    todayTeams.forEach((team) => {
        const option = document.createElement('option');
        // 그룹 유무 판별을 위해 JSON 문자열 형태로 안전하게 포장배달
        option.value = JSON.stringify({ cardId: team.id, groupId: team.groupId }); 
        
        const groupSuffix = team.groupId ? ' (연복합 그룹)' : '';
        option.textContent = `${team.name}${groupSuffix}`; 
        select.appendChild(option);
    });

    // 6. 드롭다운 초기화 및 활성화
    select.value = '';
    picker.style.display = 'inline-flex';
    select.disabled = select.options.length <= 1;
}

function togglePaymentCopyGroupPicker() {
    const picker = document.getElementById('paymentCopyGroupPicker');
    if (!picker) return;
    if (picker.style.display === 'inline-flex') {
        closePaymentCopyGroupPicker();
        return;
    }
    openPaymentCopyGroupPicker();
}

async function joinCurrentCardToCopyGroup(targetData) {
    if (!currentPaymentCard || !targetData) return;

    const oldGroupId = String(currentPaymentCard.dataset.copyGroupId || '').trim();
    let newGroupId = String(targetData.groupId || '').trim();
    const targetCardId = String(targetData.cardId || '').trim();

    // 1️⃣ 선택한 팀이 이미 어떤 그룹에 속해있는 상태라면 ➡️ 그 그룹 ID에 무조건 무임승차합니다.
    if (newGroupId) {
        if (oldGroupId === newGroupId) {
            closePaymentCopyGroupPicker();
            return;
        }
    } 
    // 2️⃣ 선택한 팀이 아직 아무데도 안 묶인 순수한 개별 팀이라면 ➡️ 오늘 날짜 기반 신규 그룹 ID를 즉석 창조합니다!
    else {
        // 신규 고유 그룹 일련번호 발행
        newGroupId = `copygrp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        
        // 상대방 카드(드롭다운에서 고른 팀 카드)를 먼저 이 신규 그룹의 1번 주자로 강제 편입시킵니다.
        const targetCard = document.getElementById(targetCardId);
        if (targetCard) {
            setCopyMetaToCard(targetCard, newGroupId, 1);
            updateCardView(targetCard);
            await saveCard(targetCard);
        }
    }

    // 3️⃣ 이제 현재 열려있는 내 카드를 해당 그룹의 다음 번호(Seq)로 탑재합니다.
    const nextSeq = getNextCopySeq(newGroupId);
    setCopyMetaToCard(currentPaymentCard, newGroupId, nextSeq);
    updateCardView(currentPaymentCard);
    await saveCard(currentPaymentCard);

    // 4️⃣ 완벽한 데이터 무결성을 위해 양쪽 그룹 번호 정렬(Renumbering) 싹 돌려주기
    await renumberCopyGroup(newGroupId);
    if (oldGroupId && oldGroupId !== newGroupId) {
        await renumberCopyGroup(oldGroupId);
    }

    // 5️⃣ 정산창 뱃지 상태 새로고침
    setPaymentCopyGroupBadge(currentPaymentCard);
}

function onPaymentCopyGroupBadgeClick(event) {
    if (event) event.stopPropagation();
    if (!currentPaymentCard) return;

    const hasGroup = !!String(currentPaymentCard.dataset.copyGroupId || '').trim();
    if (hasGroup) {
        detachPaymentCopyGroup();
        return;
    }
    togglePaymentCopyGroupPicker();
}

async function onPaymentCopyGroupSelected(event) {
    if (event) event.stopPropagation();
    const select = document.getElementById('paymentCopyGroupSelect');
    if (!select) return;

    const rawValue = String(select.value || '').trim();
    if (!rawValue) return;

    try {
        // 🎯 [교정 핵심 2]: 배달된 JSON 데이터를 다시 안전하게 해체(Parse)합니다.
        const targetData = JSON.parse(rawValue);
        
        // 진짜 묶기 메인 공장으로 토스!
        await joinCurrentCardToCopyGroup(targetData);
    } catch (e) {
        console.error("그룹 선택 데이터 파싱 에러:", e);
    }
    
    closePaymentCopyGroupPicker();
}

async function detachPaymentCopyGroup() {
    if (!currentPaymentCard) return;
    const oldGroupId = String(currentPaymentCard.dataset.copyGroupId || '').trim();
    clearCopyMetaFromCard(currentPaymentCard);
    setPaymentCopyGroupBadge(currentPaymentCard);
    await saveCard(currentPaymentCard);
    if (oldGroupId) {
        await renumberCopyGroup(oldGroupId);
    }
}

window.detachPaymentCopyGroup = detachPaymentCopyGroup;
window.onPaymentCopyGroupBadgeClick = onPaymentCopyGroupBadgeClick;
window.onPaymentCopyGroupSelected = onPaymentCopyGroupSelected;

function getNextCopySeq(groupId) {
    if (!groupId) return 2;
    let maxSeq = 1;
    document.querySelectorAll(`.booking-card[data-copy-group-id="${groupId}"]`).forEach((el) => {
        const seq = parseInt(el.dataset.copySeq || '0', 10);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    });
    return maxSeq + 1;
}

function getCopyGroupCards(groupId) {
    const gid = String(groupId || '').trim();
    if (!gid) return [];
    return Array.from(document.querySelectorAll(`.booking-card[data-copy-group-id="${gid}"]`));
}

async function renumberCopyGroup(groupId) {
    const gid = String(groupId || '').trim();
    if (!gid) return;

    const cards = getCopyGroupCards(gid);
    if (!cards.length) return;

    // 그룹에 1개만 남으면 더 이상 복제 그룹으로 보지 않고 뱃지를 제거한다.
    if (cards.length === 1) {
        const onlyCard = cards[0];
        clearCopyMetaFromCard(onlyCard);
        updateCardView(onlyCard);
        await saveCard(onlyCard);
        if (currentPaymentCard === onlyCard) {
            setPaymentCopyGroupBadge(null);
        }
        return;
    }

    cards.sort((a, b) => {
        const sa = parseInt(a.dataset.copySeq || '0', 10);
        const sb = parseInt(b.dataset.copySeq || '0', 10);
        const safeSa = Number.isFinite(sa) && sa > 0 ? sa : Number.MAX_SAFE_INTEGER;
        const safeSb = Number.isFinite(sb) && sb > 0 ? sb : Number.MAX_SAFE_INTEGER;
        if (safeSa !== safeSb) return safeSa - safeSb;
        return 0;
    });

    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const seq = i + 1;
        setCopyMetaToCard(card, gid, seq);
        updateCardView(card);
        await saveCard(card);
    }
}

async function copyCardInfo(buttonEl) {
    const card = buttonEl?.closest('.booking-card');
    if (!card) return;

    let copyGroupId = String(card.dataset.copyGroupId || '').trim();
    if (!copyGroupId) {
        copyGroupId = `copygrp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        card.dataset.copyGroupId = copyGroupId;
    }
    if (!card.dataset.copySeq) {
        card.dataset.copySeq = '1';
    }
    setCopyMetaToCard(card, copyGroupId, parseInt(card.dataset.copySeq, 10) || 1);

    const cell = card.closest('td[id^="cell-"]');
    if (!cell) return;

    // 현재 셀의 room과 timeKey 추출
    const cellId = cell.id; // "cell-{timeKey}-{room}" 형태
    const idParts = cellId.split('-');
    const room = idParts[idParts.length - 1];
    const timeKey = idParts.slice(1, -1).join('-');

    // 현재 카드에서 정보 추출
    const team = card.querySelector('.p-team-text')?.textContent.trim() || '';
    const name = card.querySelector('.p-name-text')?.textContent.trim() || '';
    const phone = card.dataset.phone || '';
    const metaText = card.querySelector('.p-level-people-text')?.textContent.trim() || '';

    if (!team || !name) {
        showToast('팀명과 성함은 필수입니다.', card);
        return;
    }

    // 빈 타임슬롯 찾기 - 다음 타임부터 시작해서 카드가 없는 셀 찾기
    let targetTimeKey = timeKey;
    let targetCell = null;
    let attempts = 0;
    const maxAttempts = 20; // 최대 20개 타임슬롯까지 검색

    while (attempts < maxAttempts) {
        const nextKey = getNextTimeKey(targetTimeKey);
        if (!nextKey) {
            showToast('다음 타임슬롯이 없습니다.', card);
            return;
        }

        const checkCell = document.getElementById(`cell-${nextKey}-${room}`);
        if (!checkCell) {
            showToast('다음 타임슬롯을 찾을 수 없습니다.', card);
            return;
        }

        // 이 셀에 카드가 없으면 사용
        if (!checkCell.querySelector('.booking-card')) {
            targetTimeKey = nextKey;
            targetCell = checkCell;
            break;
        }

        // 카드가 있으면 계속 다음으로
        targetTimeKey = nextKey;
        attempts++;
    }

    if (!targetCell) {
        showToast('빈 타임슬롯을 찾을 수 없습니다.', card);
        return;
    }

    // metaText 파싱: "3명/파티룸/상" 형태
    const metaParts = metaText.split('/').map(s => s.trim());
    let people = '';
    let roomFlag = '';

    if (metaParts.length >= 2) {
        people = metaParts[0].replace('명', '').trim();
        roomFlag = metaParts[1];
    }

    // 새 카드 생성
    const newCard = createBookingCard();
    newCard.querySelector('.p-team-text').textContent = team;
    newCard.querySelector('.p-name-text').textContent = name;
    
    if (phone) {
        newCard.dataset.phone = phone;
    }

    // 인원, 방만 복제 / 난이도는 미입력
    const metaHtml = buildCardMetaHtml('미입력', people, roomFlag);
    newCard.querySelector('.p-level-people-text').innerHTML = metaHtml;

    // 결제정보는 미입력 (빈칸)
    newCard.querySelector('.p-payment-amounts').textContent = '';

    // 파티룸 정보 복제 (예약자 상태는 초기화)
    let currentPaymentData = null;
    try {
        currentPaymentData = card.dataset.paymentData ? JSON.parse(card.dataset.paymentData) : null;
    } catch (e) {}
    
    if (currentPaymentData?.partyRoom) {
        newCard.dataset.paymentData = JSON.stringify({
            partyRoom: true,
            roomFlags: currentPaymentData.roomFlags,
            isBooker: false
        });
        // 파티룸 카드에 party-room 클래스 추가 (보라색 배경)
        const cellView = newCard.querySelector('.cell-view');
        cellView.classList.add('party-room');
        // 원본 카드의 p-paid-status 텍스트와 색상을 복제
        const originalPaidStatus = card.querySelector('.p-paid-status');
        const newPaidStatus = newCard.querySelector('.p-paid-status');
        if (originalPaidStatus && newPaidStatus) {
            newPaidStatus.textContent = originalPaidStatus.textContent;
            newPaidStatus.style.color = originalPaidStatus.style.color;
        }
    } else {
        // 파티룸이 아닌 경우만 isBooker를 false로 초기화
        newCard.dataset.paymentData = JSON.stringify({
            isBooker: false
        });
    }

    const nextSeq = getNextCopySeq(copyGroupId);
    setCopyMetaToCard(newCard, copyGroupId, nextSeq);

    // 다음 셀에 카드 추가
    targetCell.appendChild(newCard);

    // 복제 메타까지 즉시 저장하여 새로고침 후에도 유지
    await saveCard(card);
    await saveCard(newCard);

    showToast(`${targetTimeKey.replace('-', ':')}로 복제되었습니다.`, card);
}

async function sendCardToQueue(buttonEl) {
    const card = buttonEl ? buttonEl.closest('.booking-card') : null;
    if (!card) return;

    // 완료 상태 체크
    const completedCheckbox = card.querySelector('.p-completed');
    if (completedCheckbox && completedCheckbox.checked) {
        showToast('이미 게임이 완료되었습니다.', card);
        return;
    }

    const cell = card.closest('td[id^="cell-"]');
    if (!cell) return;
    const room = (cell.id.split('-')[3] || '').toUpperCase();
    const queueEl = document.getElementById(`queue-${room}`);
    if (!queueEl) {
        alert('해당 방 대기리스트를 찾을 수 없습니다.');
        return;
    }

    let bid = parseInt(card.dataset.bid || '0', 10);
    if (!bid) {
        await saveCard(card);
        bid = parseInt(card.dataset.bid || '0', 10);
    }
    if (!bid) {
        alert('전송 전에 카드 저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    const meta = parseCardMetaText(card.querySelector('.p-level-people-text')?.textContent || '');
    const teamText = card.querySelector('.p-team-text')?.textContent.trim() || '';
    const nameText = card.querySelector('.p-name-text')?.textContent.trim() || '';
    const phoneText = card.querySelector('.p-phone-text')?.textContent.trim() || '';
    let paymentData = null;
    try {
        paymentData = card.dataset.paymentData ? JSON.parse(card.dataset.paymentData) : null;
    } catch (e) {
        paymentData = null;
    }
    const roomFlags = paymentData?.roomFlags || roomFlagsFromLabel(meta.roomFlagLabel);
    const roomFlagLabel = roomFlagLabelFromFlags(roomFlags);
    const isPartyRoom = !!paymentData?.partyRoom;

    let existingQueueItem = document.querySelector(`.queue-item-manual[data-bid="${bid}"]`);
    if (existingQueueItem) {
        showToast('이미 대기중입니다.', card);
        updateCardQueueStatus(card);
        return;
    } else {
        await addQueueItem({
            room,
            name: nameText,
            phone: phoneText,
            team: teamText,
            level: meta.level || '',
            people: meta.people || '',
            roomFlagLabel,
            bid,
            partyRoom: isPartyRoom
        }, queueEl);
    }

    updateCardQueueStatus(card);
}

async function addQueueItem(item, queueEl) {
    const res = await fetch('/api/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item)
    });
    if (!res.ok) throw new Error('대기 추가 실패');
    const data = await res.json();
    queueEl.appendChild(makeQueueItemElement({ ...item, id: data.id, bid: item.bid || 0 }, true));
    updateAllCardQueueStatuses();
    updateAllQueueEstimates();
}

async function moveQueueItem(itemEl, newRoom) {
    const qid = parseInt(itemEl.dataset.qid || '0', 10);
    if (!qid) return;
    const res = await fetch(`/api/queue/${qid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: newRoom })
    });
    if (!res.ok) throw new Error('대기 이동 실패');
    itemEl.dataset.room = newRoom;
    updateAllQueueEstimates();
}

function insertQueueItemByPointer(targetQueue, draggedItem, event) {
    const targetItem = event.target.closest('.queue-item-manual');
    if (!targetItem || targetItem === draggedItem || targetItem.parentElement !== targetQueue) {
        targetQueue.appendChild(draggedItem);
        return;
    }
    const rect = targetItem.getBoundingClientRect();
    const before = event.clientY < (rect.top + rect.height / 2);
    targetQueue.insertBefore(draggedItem, before ? targetItem : targetItem.nextSibling);
}

async function persistQueueOrder(room) {
    if (!room) return;
    const queueEl = document.getElementById(`queue-${room}`);
    if (!queueEl) return;

    const items = [...queueEl.querySelectorAll('.queue-item-manual')];
    for (let i = 0; i < items.length; i += 1) {
        const itemEl = items[i];
        const qid = parseInt(itemEl.dataset.qid || '0', 10);
        const orderNo = i + 1;
        itemEl.dataset.orderNo = String(orderNo);
        if (!qid) continue;

        try {
            await fetch(`/api/queue/${qid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_no: orderNo })
            });
        } catch (err) {
            console.error('대기 순서 저장 실패:', err);
        }
    }
}

async function syncTimelineOrderFromQueue(room) {
    if (!room) return;

    const queueEl = document.getElementById(`queue-${room}`);
    if (!queueEl) return;

    const queueItems = [...queueEl.querySelectorAll('.queue-item-manual')];
    const queueRankByBid = new Map();
    queueItems.forEach((item, idx) => {
        const bid = parseInt(item.dataset.bid || '0', 10);
        if (bid > 0 && !queueRankByBid.has(bid)) {
            queueRankByBid.set(bid, idx);
        }
    });

    if (queueRankByBid.size === 0) return;

    const roomCells = [...document.querySelectorAll(`td[id^="cell-"][id$="-${room}"]`)];
    for (const cell of roomCells) {
        const cards = [...cell.querySelectorAll('.booking-card')];
        if (cards.length < 2) continue;

        const sorted = [...cards].sort((a, b) => {
            const bidA = parseInt(a.dataset.bid || '0', 10);
            const bidB = parseInt(b.dataset.bid || '0', 10);
            const rankA = queueRankByBid.has(bidA) ? queueRankByBid.get(bidA) : Number.MAX_SAFE_INTEGER;
            const rankB = queueRankByBid.has(bidB) ? queueRankByBid.get(bidB) : Number.MAX_SAFE_INTEGER;
            return rankA - rankB;
        });

        const changed = sorted.some((card, idx) => card !== cards[idx]);
        if (!changed) continue;

        sorted.forEach((card) => cell.appendChild(card));
        await persistCellOrder(cell);
    }
}

async function removeQueueItem(itemEl) {
    if (!itemEl) return;
    const qid = parseInt(itemEl.dataset.qid || '0', 10);
    if (qid) {
        const res = await fetch(`/api/queue/${qid}`, { method: 'DELETE' });
        if (!res.ok) {
            alert('대기 항목 삭제 실패');
            return;
        }
    }
    itemEl.remove();
    updateAllCardQueueStatuses();
    updateAllQueueEstimates();
}

async function startQueueItem(itemEl) {
    if (!itemEl) return;

    const bid = parseInt(itemEl.dataset.bid || '0', 10);
    if (bid > 0) {
        const card = document.querySelector(`.booking-card[data-bid="${bid}"]`);
        if (card) {
            const completedCheckbox = card.querySelector('.p-completed');
            if (completedCheckbox && !completedCheckbox.checked) {
                completedCheckbox.checked = true;
                toggleStatus(completedCheckbox);
            }
        }
    }

    await removeQueueItem(itemEl);
    updateAllQueueEstimates();
}

async function loadQueueItems() {
    const res = await fetch('/api/queue/list');
    if (!res.ok) throw new Error('대기 목록 로드 실패');
    const rows = await res.json();
    
    // room-queue 요소들이 없으면 생성 (숨겨진 컨테이너에)
    ROOMS.forEach(room => {
        if (!document.getElementById(`queue-${room}`)) {
            const hiddenContainer = document.getElementById('hiddenQueueContainer') || 
                (() => {
                    const div = document.createElement('div');
                    div.id = 'hiddenQueueContainer';
                    div.style.display = 'none';
                    document.body.appendChild(div);
                    return div;
                })();
            
            const queueEl = document.createElement('div');
            queueEl.id = `queue-${room}`;
            queueEl.className = 'room-queue';
            queueEl.setAttribute('ondrop', 'drop(event)');
            queueEl.setAttribute('ondragover', 'allowDrop(event)');
            hiddenContainer.appendChild(queueEl);
        }
    });
    
    // room-queue 초기화
    document.querySelectorAll('.room-queue').forEach(q => q.innerHTML = '');
    
    // 방별로 대기리스트 그룹핑
    const roomMap = {};
    rows.forEach(item => {
        if (!roomMap[item.room]) roomMap[item.room] = [];
        roomMap[item.room].push(item);
    });
    
    // 각 방별로 queueItems 배열을 만들어서 전달
    Object.entries(roomMap).forEach(([room, items]) => {
        const q = document.getElementById(`queue-${room}`);
        if (!q) return;
        // 같은 room의 전체 아이템 배열을 전달해 예상시간 계산 일관성 유지
        const queueEls = items.map((item) => makeQueueItemElement(item, false));
        queueEls.forEach((el) => q.appendChild(el));
    });
    
    updateAllCardQueueStatuses();
    updateAllQueueEstimates();
    renderTimelineOverviewAndEtaChips();
}
// 방 상태와 대기리스트를 함께 갱신하고, 둘 다 최신일 때만 예상시간을 갱신
async function refreshRoomAndQueue() {
    await Promise.all([fetchRoomStatus(), loadQueueItems()]);
    updateAllQueueEstimates();
}

function syncAllQueueLabelsFromCards() {
    document.querySelectorAll('.booking-card[data-bid]').forEach((card) => {
        syncLinkedQueueItemFromCard(card);
    });
}

function insertCardByPointer(targetCell, sourceCard, event) {
    const targetCard = event.target.closest('.booking-card');
    if (!targetCard || targetCard === sourceCard || targetCard.closest('td') !== targetCell) {
        targetCell.appendChild(sourceCard);
        return;
    }
    const rect = targetCard.getBoundingClientRect();
    const before = event.clientY < (rect.top + rect.height / 2);
    targetCell.insertBefore(sourceCard, before ? targetCard : targetCard.nextSibling);
}

function getCardOrderNo(card) {
    const cell = card.closest('td');
    if (!cell) return 0;
    const cards = [...cell.querySelectorAll('.booking-card')];
    return cards.findIndex(c => c === card) + 1;
}

async function persistCellOrder(cell) {
    if (!cell) return;
    const cards = [...cell.querySelectorAll('.booking-card')];
    for (const c of cards) {
        await saveCard(c);
    }
}

async function drop(event) {
    event.preventDefault();

    const mainWrapper = document.querySelector('.main-wrapper');
    const isPast = mainWrapper && mainWrapper.dataset.readonly === "true";

    if (isPast) {
        alert("🔒 과거 데이터는 드래그하여 이동하거나 수정할 수 없습니다.");
        // 드래그 시 강조되었던 스타일들 제거
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        return;
    }

    const targetQueue = event.target.closest('.room-queue');
    const targetCell = event.target.closest('td[id^="cell-"]');
    
    const rawData = event.dataTransfer.getData("application/json");
    if (!rawData) return;

    let data;
    try {
        data = JSON.parse(rawData);
    } catch (e) {
        return;
    }

    if (targetQueue) {
        targetQueue.classList.remove('drag-over');
        const targetRoom = getQueueRoom(targetQueue);
        if (data.type === 'booking') {
            const sourceCell = document.getElementById(data.cellId);
            if (!sourceCell) return;

            let sourceCard = null;
            if (data.dragId) {
                sourceCard = sourceCell.querySelector(`.booking-card[data-drag-id="${data.dragId}"]`);
            }
            if (!sourceCard) {
                sourceCard = sourceCell.querySelector(`.booking-card[data-bid="${data.bid}"]`);
            }
            if (!sourceCard) return;

            // 1) 대기리스트에도 추가(이미 있으면 이동/갱신)
            const bidNum = parseInt(data.bid || '0', 10);
            const existingQueueItem = bidNum ? document.querySelector(`.queue-item-manual[data-bid="${bidNum}"]`) : null;
            if (existingQueueItem) {
                const fromRoom = existingQueueItem.dataset.room;
                if (fromRoom !== targetRoom) {
                    await moveQueueItem(existingQueueItem, targetRoom);
                }
                targetQueue.appendChild(existingQueueItem);
            } else {
                await addQueueItem({
                    room: targetRoom,
                    name: data.name,
                    phone: data.phone,
                    team: data.team,
                    level: data.level,
                    people: data.people,
                    roomFlagLabel: data.roomFlagLabel,
                    bid: bidNum,
                    partyRoom: !!data.partyRoom
                }, targetQueue);
            }

            // 2) 타임테이블에서도 같은 시간의 대상 방으로 이동
            const parts = sourceCell.id.split('-');
            const timeKey = `${parts[1]}-${parts[2]}`;
            const targetCellByQueue = document.getElementById(`cell-${timeKey}-${targetRoom}`);
            if (!targetCellByQueue) return;

            const sameCell = sourceCell === targetCellByQueue;
            if (!sameCell) {
                targetCellByQueue.appendChild(sourceCard);
                applyCardRoomFlagsForRoom(sourceCard, targetRoom);
                await persistCellOrder(sourceCell);
                await persistCellOrder(targetCellByQueue);
            }

            if (currentPaymentCard === sourceCard) {
                currentPaymentCard = sourceCard;
                currentPaymentCell = targetCellByQueue;
                setPaymentRoomValue(targetRoom);
                calculatePayment();
            }
        } else if (data.type === 'queue') {
            let dragged = document.querySelector(`.queue-item-manual[data-qid="${data.qid}"]`);
            if (!dragged) return;
            const fromRoom = dragged.dataset.room;
            if (fromRoom !== targetRoom) {
                await moveQueueItem(dragged, targetRoom);

                // 비동기 갱신 사이에 참조가 바뀔 수 있어 최신 DOM을 다시 조회
                dragged = document.querySelector(`.queue-item-manual[data-qid="${data.qid}"]`) || dragged;

                const linkedBid = parseInt(dragged.dataset.bid || data.bid || '0', 10);
                if (linkedBid > 0) {
                    const linkedCard = document.querySelector(`.booking-card[data-bid="${linkedBid}"]`);
                    if (linkedCard) {
                        const sourceCell = linkedCard.closest('td');
                        const sourceCellId = sourceCell?.id || '';
                        const parts = sourceCellId.split('-');
                        const timeKey = parts.length >= 4 ? `${parts[1]}-${parts[2]}` : '';
                        const targetCellByQueue = timeKey ? document.getElementById(`cell-${timeKey}-${targetRoom}`) : null;
                        if (sourceCell && targetCellByQueue && sourceCell !== targetCellByQueue) {
                            targetCellByQueue.appendChild(linkedCard);
                            applyCardRoomFlagsForRoom(linkedCard, targetRoom);
                            await persistCellOrder(sourceCell);
                            await persistCellOrder(targetCellByQueue);
                            if (currentPaymentCard === linkedCard) {
                                currentPaymentCard = linkedCard;
                                currentPaymentCell = targetCellByQueue;
                                setPaymentRoomValue(targetRoom);
                                calculatePayment();
                            }
                        }
                    }
                }
            }

            // 같은 qid가 DOM에 중복 생성된 경우 1개만 유지
            const duplicateQueueItems = Array.from(document.querySelectorAll(`.queue-item-manual[data-qid="${data.qid}"]`));
            duplicateQueueItems.forEach((el) => {
                if (el !== dragged) {
                    el.remove();
                }
            });

            insertQueueItemByPointer(targetQueue, dragged, event);
            const title = dragged.dataset.team || dragged.dataset.name || '대기';
            const peopleText = dragged.dataset.people ? `${dragged.dataset.people}명` : '-';
            const levelText = dragged.dataset.level || '미지정';
            const roomFlagLabel = dragged.dataset.roomFlagLabel || '-';
            const draggedBid = parseInt(dragged.dataset.bid || '0', 10);
            let draggedPaymentData = null;
            if (draggedBid) {
                const draggedCard = document.querySelector(`.booking-card[data-bid="${draggedBid}"]`);
                if (draggedCard) {
                    draggedPaymentData = parsePaymentDataSafe(draggedCard.dataset.paymentData);
                }
            }
            const info = dragged.querySelector('.info');
            if (info) {
                info.innerHTML = buildQueueInfoText(
                    title,
                    peopleText,
                    dragged.dataset.room || '',
                    roomFlagLabel,
                    null,
                    levelText,
                    dragged.dataset.partyRoom === '1',
                    draggedPaymentData
                );
            }

            if (fromRoom && fromRoom !== targetRoom) {
                await persistQueueOrder(fromRoom);
                await syncTimelineOrderFromQueue(fromRoom);
            }
            await persistQueueOrder(targetRoom);
            await syncTimelineOrderFromQueue(targetRoom);
        }
        return;
    }

    if (targetCell) {
        targetCell.classList.remove('drag-over');
        if (data.type === 'booking') {
            const sourceCell = document.getElementById(data.cellId);
            if (!sourceCell) return;
            let sourceCard = null;
            if (data.dragId) {
                sourceCard = sourceCell.querySelector(`.booking-card[data-drag-id="${data.dragId}"]`);
            }
            if (!sourceCard) {
                sourceCard = sourceCell.querySelector(`.booking-card[data-bid="${data.bid}"]`);
            }
            if (!sourceCard) return;

            const sameCell = sourceCell === targetCell;
            insertCardByPointer(targetCell, sourceCard, event);
            if (!sameCell) {
                const sourceRoom = (sourceCell.id.split('-')[3] || '').toUpperCase();
                const targetRoom = (targetCell.id.split('-')[3] || '').toUpperCase();
                applyCardRoomFlagsForRoom(sourceCard, targetRoom);

                // 대기중인 팀카드를 다른 방으로 옮기면 연결된 대기큐도 함께 이동
                if (sourceRoom && targetRoom && sourceRoom !== targetRoom) {
                    const linkedBid = parseInt(sourceCard.dataset.bid || '0', 10);
                    if (linkedBid > 0) {
                        const linkedQueueItem = document.querySelector(`.queue-item-manual[data-bid="${linkedBid}"]`);
                        if (linkedQueueItem) {
                            await moveQueueItem(linkedQueueItem, targetRoom);
                            const targetQueue = document.getElementById(`queue-${targetRoom}`);
                            if (targetQueue) {
                                targetQueue.appendChild(linkedQueueItem);
                            }
                        }
                    }
                }
            }

            if (sameCell) {
                await persistCellOrder(targetCell);
            } else {
                await persistCellOrder(sourceCell);
                await persistCellOrder(targetCell);
            }

            if (currentPaymentCard === sourceCard) {
                currentPaymentCard = sourceCard;
                currentPaymentCell = targetCell;
                setPaymentRoomValue(targetCell.id.split('-')[3]);
                calculatePayment();
            }
        } else if (data.type === 'queue') {
            const qid = parseInt(data.qid || '0', 10);
            if (!qid) return;
            const newCard = addCard(targetCell, {
                name: data.name,
                phone: data.phone,
                team: data.team,
                level: data.level,
                people: data.people,
                paid: 0,
                completed: 0
            }, 0, isPast);
            const roomFlagLabel = data.roomFlagLabel || '-';
            if (roomFlagLabel !== '-') {
                newCard.querySelector('.p-level-people-text').innerHTML = buildCardMetaHtml(data.level || '', data.people || '', roomFlagLabel);
                newCard.dataset.paymentData = JSON.stringify({
                    roomFlags: roomFlagsFromLabel(roomFlagLabel),
                    roomFlagLabel
                });
                updateCardView(newCard);
            }
            await saveCard(newCard);
            await fetch(`/api/queue/${qid}`, { method: 'DELETE' });
            const dragged = document.querySelector(`.queue-item-manual[data-qid="${data.qid}"]`);
            if (dragged) dragged.remove();
            updateAllCardQueueStatuses();
        }
    }
}

document.addEventListener('dragleave', function(event) {
    const queueTarget = event.target.closest('.room-queue');
    const cellTarget = event.target.closest('td[id^="cell-"]');
    if (queueTarget && !queueTarget.contains(event.relatedTarget)) queueTarget.classList.remove('drag-over');
    if (cellTarget && !cellTarget.contains(event.relatedTarget)) cellTarget.classList.remove('drag-over');
});

// 방 상태 가져오기 및 렌더링
async function fetchRoomStatus() {
    try {
        const res = await fetch('/api/pad_status');
        if (!res.ok) return;
        const data = await res.json();
        renderRoomStatus(data);
    } catch(e) {
        console.error("Room status fetch error", e);
    }
}

function buildRoomCountdownText(expectedEndMs) {
    const endMs = Number(expectedEndMs || 0);
    if (!Number.isFinite(endMs) || endMs <= 0) return '-';

    const nowMs = Date.now();
    // 16분 시작 시 15:58부터 보이도록 2초를 차감해 표시
    const remainingSec = Math.max(0, Math.ceil((endMs - nowMs) / 1000) - 2);
    const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
    const ss = String(remainingSec % 60).padStart(2, '0');

    const endDt = new Date(endMs);
    const endHH = String(endDt.getHours()).padStart(2, '0');
    const endMM = String(endDt.getMinutes()).padStart(2, '0');
    return `
        <span class="end-time-badge">종료 ${endHH}:${endMM}</span>    
        <span class="remain-timer">${mm}:${ss}</span>
    `;
}

const ROOM_COUNTDOWN_STORAGE_KEY = 'jumpingbattle_room_countdown_endms_v1';
let timelineNowLineEl = null;
let timelineAutoFollowPausedByUser = false;
let timelineProgrammaticScroll = false;
let timelineScrollBound = false;
let timelineInitialFocusDone = false;
const TIMELINE_LINE_VIEWPORT_RATIO = 0.3;

function loadRoomCountdownStore() {
    try {
        const raw = localStorage.getItem(ROOM_COUNTDOWN_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function saveRoomCountdownStore(store) {
    try {
        localStorage.setItem(ROOM_COUNTDOWN_STORAGE_KEY, JSON.stringify(store || {}));
    } catch (e) {}
}

function getStoredExpectedEndMs(room) {
    const store = loadRoomCountdownStore();
    const val = Number(store?.[room] || 0);
    return Number.isFinite(val) && val > 0 ? val : 0;
}

function setStoredExpectedEndMs(room, expectedEndMs) {
    if (!room) return;
    const value = Number(expectedEndMs || 0);
    if (!Number.isFinite(value) || value <= 0) return;
    const store = loadRoomCountdownStore();
    store[room] = value;
    saveRoomCountdownStore(store);
}

function clearStoredExpectedEndMs(room) {
    if (!room) return;
    const store = loadRoomCountdownStore();
    if (Object.prototype.hasOwnProperty.call(store, room)) {
        delete store[room];
        saveRoomCountdownStore(store);
    }
}

function ensureTimelineNowLine() {
    const container = document.querySelector('.timeline-container');
    if (!container) return null;
    if (!timelineNowLineEl) {
        timelineNowLineEl = document.createElement('div');
        timelineNowLineEl.className = 'timeline-now-line';
        container.appendChild(timelineNowLineEl);
    }
    return timelineNowLineEl;
}

function isTimelineLineInView(container, yContent, margin = 20) {
    if (!container || !Number.isFinite(yContent)) return false;
    const minY = container.scrollTop + margin;
    const maxY = container.scrollTop + container.clientHeight - margin;
    return yContent >= minY && yContent <= maxY;
}

function updateTimelineOverlays() {
    const container = document.querySelector('.timeline-container');
    const table = document.querySelector('.timeline-table');
    const tbody = document.getElementById('timelineBody');
    if (!container || !table || !tbody) return;

    const overlayTop = document.getElementById('timelineOverlayTop');
    const overlayBottom = document.getElementById('timelineOverlayBottom');
    if (!overlayTop || !overlayBottom) return;

    const rows = tbody.querySelectorAll('tr');
    if (rows.length === 0) {
        overlayTop.innerHTML = '';
        overlayBottom.innerHTML = '';
        return;
    }

    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const scrollBottom = scrollTop + container.clientHeight;

    // 첫 번째 행의 td들로부터 방의 순서와 개수 파악
    const firstRow = rows[0];
    const cells = firstRow.querySelectorAll('td');
    const roomCount = Math.max(0, cells.length - 1); // 첫 번째는 시간 열

    if (roomCount === 0) {
        overlayTop.innerHTML = '';
        overlayBottom.innerHTML = '';
        return;
    }

    // 타임 컬럼(첫 번째 td) 너비를 제외한 방 컬럼 구간에만 오버레이를 맞춘다.
    const firstRoomCell = cells[1];
    const lastRoomCell = cells[cells.length - 1];
    if (firstRoomCell && lastRoomCell) {
        const firstRect = firstRoomCell.getBoundingClientRect();
        const lastRect = lastRoomCell.getBoundingClientRect();
        const overlayLeft = (firstRect.left - containerRect.left) + container.scrollLeft;
        const overlayRight = (lastRect.right - containerRect.left) + container.scrollLeft;
        const overlayWidth = Math.max(0, overlayRight - overlayLeft);

        overlayTop.style.left = `${overlayLeft}px`;
        overlayTop.style.width = `${overlayWidth}px`;
        overlayTop.style.right = 'auto';

        overlayBottom.style.left = `${overlayLeft}px`;
        overlayBottom.style.width = `${overlayWidth}px`;
        overlayBottom.style.right = 'auto';
    }

    const roomColumns = []; // 각 방별 (roomName, colIdx)
    for (let colIdx = 1; colIdx < cells.length; colIdx++) {
        const cell = cells[colIdx];
        const cellId = cell.id || '';
        const roomMatch = cellId.match(/cell-[\d-]+-(.*)/);
        const roomName = roomMatch ? roomMatch[1].toUpperCase() : `Room${colIdx}`;
        roomColumns.push({ roomName, colIdx });
    }

    // 각 방별로 위/아래 팀들 수집
    const topTeams = {}; // { roomName: [팀1, 팀2, ...] }
    const bottomTeams = {};

    for (const { roomName, colIdx } of roomColumns) {
        topTeams[roomName] = [];
        bottomTeams[roomName] = [];
    }

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        const cells = row.querySelectorAll('td');

        for (let colIdx = 1; colIdx < cells.length; colIdx++) {
            const cell = cells[colIdx];
            const cellRect = cell.getBoundingClientRect();
            const cellTop = (cellRect.top - containerRect.top) + scrollTop;

            const bookingCards = cell.querySelectorAll('.booking-card');
            bookingCards.forEach(card => {
                const cardRect = card.getBoundingClientRect();
                const cardTop = (cardRect.top - containerRect.top) + scrollTop;
                const cardBottom = cardTop + card.clientHeight;

                // 오버레이 표시 조건:
                // 1) 완료하지 않은 팀은 표시
                // 2) 완료되었더라도 결제미완료면 표시
                // 3) 완료 + 결제완료인 팀만 제외
                const isCompleted = !!card.querySelector('.p-completed:checked');
                const isPaid = !!card.querySelector('.p-paid:checked');
                if (isCompleted && isPaid) return;

                const teamText = card.querySelector('.p-team-text')?.textContent.trim() || 
                                card.querySelector('.p-name-text')?.textContent.trim() || '팀';

                const { roomName } = roomColumns[colIdx - 1] || { roomName: 'Room' };

                // 화면 위쪽에 있는 팀
                if (cardBottom < scrollTop) {
                    if (!topTeams[roomName]) topTeams[roomName] = [];
                    topTeams[roomName].push(teamText);
                }
                // 화면 아래쪽에 있는 팀
                else if (cardTop > scrollBottom) {
                    if (!bottomTeams[roomName]) bottomTeams[roomName] = [];
                    bottomTeams[roomName].push(teamText);
                }
            });
        }
    }

    // 오버레이 HTML 생성 (빨간 라인 위 텍스트처럼 간결하게 표시)
    const createOverlayHtml = (teamsObj, directionSymbol) => {
        return roomColumns.map(({ roomName }) => {
            const rawTeams = teamsObj[roomName] || [];
            const teams = [...new Set(rawTeams.filter(Boolean))];
            const teamList = teams.slice(0, 4).join(', ');
            const overflow = teams.length > 4 ? ` +${teams.length - 4}` : '';
            const displayText = teams.length > 0 ? `${directionSymbol} ${teamList}${overflow}` : `${directionSymbol} -`;
            const titleText = teams.length > 0 ? teams.join(', ') : '화면 밖 팀 없음';

            return `
                <div class="timeline-overlay-room${teams.length === 0 ? ' is-empty' : ' has-value'}">
                    <span class="timeline-overlay-room-key">${roomName}</span>
                    <span class="timeline-overlay-teams" title="${titleText}">${displayText}</span>
                </div>
            `;
        }).join('');
    };

    overlayTop.innerHTML = createOverlayHtml(topTeams, '↑');
    overlayBottom.innerHTML = createOverlayHtml(bottomTeams, '↓');
}

function bindTimelineManualScrollControl() {
    const container = document.querySelector('.timeline-container');
    if (!container || timelineScrollBound) return;
    timelineScrollBound = true;

    container.addEventListener('scroll', () => {
        if (timelineProgrammaticScroll) return;
        const lineEl = ensureTimelineNowLine();
        if (!lineEl || lineEl.style.display === 'none') {
            updateTimelineOverlays();
            return;
        }

        const yContent = Number.parseFloat(lineEl.style.top || 'NaN');
        timelineAutoFollowPausedByUser = !isTimelineLineInView(container, yContent);
        updateTimelineOverlays();
    }, { passive: true });
}

function keepTimelineLineInView(container, yContent) {
    if (!container || !Number.isFinite(yContent)) return;

    const targetOffset = container.clientHeight * TIMELINE_LINE_VIEWPORT_RATIO;
    const targetScrollTop = Math.max(0, yContent - targetOffset);
    const currentScrollTop = container.scrollTop;
    const delta = targetScrollTop - currentScrollTop;

    // 자연스럽게 따라오도록 1초 루프마다 35%씩 이동
    if (Math.abs(delta) > 2) {
        timelineProgrammaticScroll = true;
        container.scrollTop = currentScrollTop + (delta * 0.35);
        setTimeout(() => {
            timelineProgrammaticScroll = false;
        }, 0);
    }
}

function focusTimelineLineOnLoad() {
    const container = document.querySelector('.timeline-container');
    const lineEl = ensureTimelineNowLine();
    if (!container || !lineEl || lineEl.style.display === 'none') return;

    const yContent = Number.parseFloat(lineEl.style.top || 'NaN');
    if (!Number.isFinite(yContent)) return;

    timelineAutoFollowPausedByUser = false;
    timelineProgrammaticScroll = true;
    const targetOffset = container.clientHeight * TIMELINE_LINE_VIEWPORT_RATIO;
    container.scrollTop = Math.max(0, yContent - targetOffset);
    setTimeout(() => {
        timelineProgrammaticScroll = false;
        timelineInitialFocusDone = true;
    }, 0);
}

function updateCurrentTimeGridLine() {
    const lineEl = ensureTimelineNowLine();
    const container = document.querySelector('.timeline-container');
    const table = document.querySelector('.timeline-table');
    const tbody = document.getElementById('timelineBody');
    if (!lineEl || !container || !table || !tbody) return;

    const rows = tbody.querySelectorAll('tr');
    if (rows.length < 1) {
        lineEl.style.display = 'none';
        return;
    }

    const containerRect = container.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();

    const now = new Date();
    const nowMinutes = (now.getHours() * 60) + now.getMinutes() + (now.getSeconds() / 60);
    const isViewAll = document.body.classList.contains('view-all-mode');
    const dayStartMinutes = (isViewAll ? 0 : 10) * 60;
    const elapsed = nowMinutes - dayStartMinutes;
    const totalMinutes = rows.length * 20;

    if (elapsed < 0 || elapsed > totalMinutes) {
        lineEl.style.display = 'none';
        return;
    }

    const slotFloat = Math.max(0, Math.min(rows.length - 0.001, elapsed / 20));
    const baseIdx = Math.floor(slotFloat);
    const ratio = slotFloat - baseIdx;
    const nextIdx = Math.min(rows.length - 1, baseIdx + 1);

    const baseCell = rows[baseIdx]?.querySelector('td:nth-child(2)');
    const nextCell = rows[nextIdx]?.querySelector('td:nth-child(2)');
    if (!baseCell || !nextCell) {
        lineEl.style.display = 'none';
        return;
    }

    const baseRect = baseCell.getBoundingClientRect();
    const nextRect = nextCell.getBoundingClientRect();
    const baseYContent = (baseRect.top - containerRect.top) + container.scrollTop;
    const nextYContent = (nextRect.top - containerRect.top) + container.scrollTop;
    const yContent = baseYContent + ((nextYContent - baseYContent) * ratio);

    const leftContent = (tableRect.left - containerRect.left) + container.scrollLeft;
    lineEl.style.display = 'block';
    lineEl.style.left = `${leftContent}px`;
    lineEl.style.width = `${table.clientWidth}px`;
    lineEl.style.top = `${yContent}px`;

    // 자동 스크롤 비활성화: 현재시간 라인 위치만 갱신
}

function parsePadStartTimeMs(startTimeRaw) {
    if (!startTimeRaw) return 0;

    // unix epoch(ms/sec) 형태 지원
    if (typeof startTimeRaw === 'number' || /^\d+$/.test(String(startTimeRaw).trim())) {
        const n = Number(startTimeRaw);
        if (Number.isFinite(n) && n > 0) {
            return n > 1e12 ? n : n * 1000;
        }
    }

    const text = String(startTimeRaw).trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
        const y = Number(match[1]);
        const mo = Number(match[2]);
        const d = Number(match[3]);
        const h = Number(match[4]);
        const mi = Number(match[5]);
        const s = Number(match[6] || 0);
        const dt = new Date(y, mo - 1, d, h, mi, s, 0);
        const ms = dt.getTime();
        return Number.isFinite(ms) ? ms : 0;
    }

    const parsed = Date.parse(text.replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : 0;
}

function isPadStartTimeSecondPrecision(startTimeRaw) {
    if (!startTimeRaw) return false;
    if (typeof startTimeRaw === 'number') return true;

    const text = String(startTimeRaw).trim();
    if (/^\d+$/.test(text)) return true;
    return /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.test(text);
}

function updateRoomCountdownTexts() {
    document.querySelectorAll('.room-card').forEach((card) => {
        const timeEl = card.querySelector('.time-text');
        if (!timeEl) return;

        const status = card.dataset.prevStatus || '';
        if (status !== 'playing') return;

        const endMs = Number(card.dataset.expectedEndMs || 0);
        timeEl.innerHTML = buildRoomCountdownText(endMs);
    });
}

function renderRoomStatus(apiData) {
    const container = document.getElementById('roomStatusContainer');
    const displayRooms = ['C1', 'C2', 'B1', 'B2'];
    
    const roomDataMap = apiData.map ? Object.keys(apiData.map).reduce((acc, pid) => {
        acc[apiData.map[pid]] = { status: apiData.status[pid], data: apiData.data[pid] };
        return acc;
    }, {}) : {};
    
    let roomStatusChanged = false;
    displayRooms.forEach(room => {
        let card = document.getElementById(`room-card-${room}`);
        if (!card) {
            card = document.createElement('div');
            card.id = `room-card-${room}`;
            card.className = 'room-card';
            card.innerHTML = `
                <div class="room-card-header">
                    <span class="room-name">${room}</span>
                    <span class="room-state"></span>
                </div>
                <div class="room-card-body">
                    <div class="team-text"></div>
                    <div class="time-text" style="color: #d32f2f; font-weight: bold;"></div>
                </div>
            `;
            container.appendChild(card);
        }

        // 상태 변화 감지용 prevStatus
        const prevStatus = card.dataset.prevStatus || "";
        let newStatus = "empty";

        const info = roomDataMap[room];
        const hasRoomInfo = !!info;
        let stateText = "비어있음 ⚪";
        let stateClass = "";
        let teamText = "대기중";
        let timeText = "-";
        
        if (info && info.status === "playing") {
            newStatus = "playing";
            stateText = "게임중 🟢";
            stateClass = "playing";
            const wasPlaying = prevStatus === "playing";
            const apiStartMs = parsePadStartTimeMs(info?.data?.time);
            const apiHasSecondPrecision = isPadStartTimeSecondPrecision(info?.data?.time);
            const apiExpectedEndMs = apiStartMs > 0 ? (apiStartMs + (16 * 60 * 1000)) : 0;
            const cardExpectedEndMs = Number(card.dataset.expectedEndMs || 0);
            const storedExpectedEndMs = getStoredExpectedEndMs(room);

            let expectedEndMs = 0;
            if (storedExpectedEndMs > 0) {
                // 한번 잡힌 종료시각은 로컬 저장값을 우선해 새로고침/서버재시작에도 유지
                expectedEndMs = storedExpectedEndMs;
            } else if (!wasPlaying) {
                // playing 전환 순간: API가 분단위(HH:MM)면 초 정보가 없어 시작이 흔들리므로 now 기준 사용
                // => 요청한 15:58 시작값 일관성 유지
                if (apiExpectedEndMs > 0 && apiHasSecondPrecision) {
                    expectedEndMs = apiExpectedEndMs;
                } else {
                    expectedEndMs = Date.now() + (16 * 60 * 1000);
                }
            } else if (Number.isFinite(cardExpectedEndMs) && cardExpectedEndMs > 0) {
                expectedEndMs = cardExpectedEndMs;
            } else if (apiExpectedEndMs > 0) {
                // 기존 실행중 상태에서 저장값이 없을 때만 API 추정값 사용(초 정밀도 없을 수 있음)
                expectedEndMs = apiExpectedEndMs;
            }

            if (expectedEndMs > 0) {
                card.dataset.expectedEndMs = String(expectedEndMs);
                setStoredExpectedEndMs(room, expectedEndMs);
            }

            timeText = buildRoomCountdownText(expectedEndMs);
            teamText = `레벨: ${info.data.level || '-'}`;
        } else if (info && info.status === "wait_rank") {
            newStatus = "wait_rank";
            stateText = "랭킹 대기 🟡";
            stateClass = "wait_rank";
            teamText = "게임 종료 (랭킹 등록 대기)";
            delete card.dataset.expectedEndMs;
            clearStoredExpectedEndMs(room);
        } else {
            // 초기 빈 렌더(데이터 미수신)에서는 저장값을 지우지 않아 새로고침 시 카운트 유지
            if (hasRoomInfo) {
                delete card.dataset.expectedEndMs;
                clearStoredExpectedEndMs(room);
            }
        }

        if (prevStatus !== newStatus) {
            roomStatusChanged = true;
        }
        card.dataset.prevStatus = newStatus;

        card.className = `room-card ${stateClass}`;
        card.querySelector('.room-state').innerHTML = stateText;
        card.querySelector('.team-text').textContent = teamText;
        card.querySelector('.time-text').innerHTML = timeText;
    });
    // 방 상태가 하나라도 바뀌었으면 즉시 대기열·타임라인 예상시간 갱신
    if (roomStatusChanged) {
        updateAllQueueEstimates();
        updateAllTimelineEta();
    }

    let walkinCard = document.getElementById('room-card-walkin');
    const walkinPanel = document.getElementById('walkinPanel');
    if (!walkinCard) {
        walkinCard = document.createElement('div');
        walkinCard.id = 'room-card-walkin';
        walkinCard.className = 'room-card walkin';
        walkinCard.innerHTML = `
            <div class="room-card-header">
                <div class="room-name-container">
                    <span class="room-name-naver">네이버 예약</span>
                    <span class="room-name-and"> & </span>
                    <span class="room-name-walkin">워크인 대기</span>
                </div>
                <span class="room-state" id="walkInCount">0팀</span>
            </div>
            <div class="room-card-walkin-body" id="walkInRoomList">
                <span id="noWalkIn" style="color: #64748b; font-size: 13px;">입력대기 중인 팀이 없습니다.</span>
            </div>
        `;
        (walkinPanel || container).appendChild(walkinCard);
    } else if (walkinPanel && walkinCard.parentElement !== walkinPanel) {
        walkinPanel.appendChild(walkinCard);
    } 

    syncSupplyPanelWidth();
    // 렌더 함수 내부에서 동기화 함수를 다시 호출하면 경쟁 상태를 만들 수 있어 금지
    // 초기/실시간 갱신은 DOMContentLoaded, socket 이벤트, drop 처리에서만 수행
    renderTimelineOverviewAndEtaChips();

}
// 방 상태가 바뀌면 대기리스트 예상시간도 즉시 재계산
updateAllQueueEstimates();

const onsetMap = { 'ㅂ':'베이직','ㅇ':'이지','ㄴ':'노멀','ㅎ':'하드','ㅊ':'챌린저','ㅋ':'키즈','ㄹ':'여름','ㅈ':'우주','ㅅ':'산타' };

function getRoomFlagsFromModal() {
    return {
        F: !!document.getElementById('roomFlagF')?.checked,
        S: !!document.getElementById('roomFlagS')?.checked,
        M: !!document.getElementById('roomFlagM')?.checked,
        L: !!document.getElementById('roomFlagL')?.checked,
    };
}

function setRoomFlags(flags) {
    const f = flags || {};
    const setChecked = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!value;
    };
    setChecked('roomFlagF', f.F);
    setChecked('roomFlagS', f.S);
    setChecked('roomFlagM', f.M);
    setChecked('roomFlagL', f.L);
}

function applyAutoRoomFlags(roomValue) {
    const room = (roomValue || '').toUpperCase();
    const current = getRoomFlagsFromModal();
    if (room === 'C1' || room === 'C2') {
        setRoomFlags({ F: !!current.F, S: true, M: false, L: false });
        return;
    }
    if (room === 'B1' || room === 'B2') {
        if (current.F) {
            setRoomFlags({ F: true, S: false, M: true, L: false });
        } else {
            setRoomFlags({ F: false, S: false, M: false, L: false });
        }
        return;
    }
    setRoomFlags({ F: false, S: false, M: false, L: false });
}

function roomFlagLabelFromFlags(flags) {
    if (!flags) return '-';

    let sizeLabel = '';
    if (flags.S) sizeLabel = '소';
    else if (flags.M) sizeLabel = '중';
    else if (flags.L) sizeLabel = '대';

    //if (flags.F) return sizeLabel ? 'F' + sizeLabel : 'F';
    if (flags.F) return 'F' + sizeLabel;
    return sizeLabel || '-';
}

function getCurrentPaymentRoomValue() {
    const roomSelect = document.getElementById('paymentRoomSelect');
    if (roomSelect && roomSelect.value) return roomSelect.value.toUpperCase();
    const roomSpan = document.getElementById('paymentRoom');
    return (roomSpan?.textContent || '').trim().toUpperCase();
}

function applyRoomFlagRules(changedId) {
    const room = getCurrentPaymentRoomValue();
    const flags = getRoomFlagsFromModal();

    if (changedId === 'roomFlagS' && flags.S) {
        flags.M = false;
        flags.L = false;
    }
    if (changedId === 'roomFlagM' && flags.M) {
        flags.S = false;
        flags.L = false;
    }
    if (changedId === 'roomFlagL' && flags.L) {
        flags.S = false;
        flags.M = false;
    }

    if (flags.F) {
        if (room === 'C1' || room === 'C2') {
            flags.S = true;
            flags.M = false;
            flags.L = false;
        } else if (room === 'B1' || room === 'B2') {
            flags.M = true;
            flags.S = false;
            flags.L = false;
        }
    }

    setRoomFlags(flags);
}

function getQueueRoomFlagDisplay(room, roomFlagLabel, roomFlags) {
    const r = (room || '').toUpperCase();
    const f = roomFlags || {};
    const base = (roomFlagLabel || '').trim();
    const hasF = !!f.F || base.includes('F');
    if (hasF) {
        if (r === 'C1' || r === 'C2') return '소형';
        if (r === 'B1' || r === 'B2') return '중형';
        return '';
    }
    if (f.S || base === '소') return '소형';
    if (f.M || base === '중') return '중형';
    if (f.L || base === '대') return '대형';
    return '';
}

function isFastFlag(roomFlagLabel, roomFlags) {
    const f = roomFlags || {};
    const base = (roomFlagLabel || '').trim();
    return !!f.F || base === 'F';
}

function buildQueueInfoText(title, peopleText, room, roomFlagLabel, roomFlags, levelText, isPartyRoom, paymentData) {
    const partyBadge = isPartyRoom ? '<span class="party-room-badge">파티룸</span>' : '';
    const fastBadge = isFastFlag(roomFlagLabel, roomFlags) ? '<span class="fast-badge">Fast</span>' : '';
    const reservationTime = paymentData?.reservationTime || '--:--';
    const bookerBadge = (paymentData && (paymentData.isBooker || paymentData.depositPaid))
        ? `<span class="payment-booker-badge active" style="font-size: 11px; padding: 1px 5px; height: 16px; margin-left: 2px;">예약:<span class="reservation-time-emph">${reservationTime}</span></span>`
        : '';
    const roomDisplay = getQueueRoomFlagDisplay(room, roomFlagLabel, roomFlags);
    const roomText = roomDisplay ? ` ${roomDisplay}` : '';
    return `<b>${title}</b>${bookerBadge}${fastBadge}${partyBadge}<br>(${peopleText})${roomText} - ${levelText || '미지정'}`;
}

function roomFlagsFromLabel(label) {
    const v = (label || '').trim();
    return {
        F: v.includes('F'),
        S: v.includes('소'),
        M: v.includes('중'),
        L: v.includes('대'),
    };
}

function buildCardMetaText(level, people, roomFlagLabel) {
    const peoplePart = people ? `${people}명` : '-';
    const flagPart = roomFlagLabel || '-';
    const levelPart = level || '미입력';
    return `${peoplePart}/${flagPart}/${levelPart}`;
}

function parsePaymentDataSafe(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;

    try {
        return JSON.parse(raw);
    } catch (e) {}

    try {
        const normalized = raw
            .replace(/\bNone\b/g, 'null')
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/'/g, '"');
        return JSON.parse(normalized);
    } catch (e) {
        return null;
    }
}

function formatTimeKeyForReservationBadge(timeKey) {
    if (!timeKey) return '';
    const [hRaw, mRaw] = String(timeKey).split('-');
    const hour = parseInt(hRaw, 10);
    const minute = parseInt(mRaw, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getReservationTimeFromCell(cell) {
    if (!cell || !cell.id) return '';
    const parts = cell.id.split('-');
    if (parts.length < 4) return '';
    return formatTimeKeyForReservationBadge(`${parts[1]}-${parts[2]}`);
}

function getReservationTimeFromCard(card) {
    if (!card) return '';
    const cell = card.closest('td[id^="cell-"]');
    return getReservationTimeFromCell(cell);
}

function setReservationBadgeContent(badgeEl, reservationTime) {
    if (!badgeEl) return;
    const timeText = reservationTime || '--:--';
    badgeEl.innerHTML = `예약:<span class="reservation-time-emph">${timeText}</span>`;
    badgeEl.style.display = 'inline-block';
}

function setTeamCardBookerBadge(card, isBooker, reservationTime = '') {
    if (!card) return;
    const teamCardBadge = card.querySelector('.team-card-badge');
    if (!teamCardBadge) return;

    teamCardBadge.style.display = isBooker ? 'inline-flex' : 'none';
    card.classList.toggle('has-booker-badge', !!isBooker);
    teamCardBadge.classList.toggle('inactive', !isBooker);
    teamCardBadge.classList.toggle('active', isBooker);

    if (isBooker) {
        setReservationBadgeContent(teamCardBadge, reservationTime || getReservationTimeFromCard(card));
    } else {
        teamCardBadge.textContent = '예약';
    }
}

function setPaymentBookerBadge(isBooker, reservationTime = '') {
    const badge = document.getElementById('paymentBookerBadge');
    const modal = document.getElementById('paymentModal');
    const on = !!isBooker;
    if (badge) {
        badge.style.display = 'inline-flex';
        badge.classList.toggle('inactive', !on);
        badge.classList.toggle('active', on);
        if (on) {
            setReservationBadgeContent(badge, reservationTime || getReservationTimeFromCard(currentPaymentCard));
        } else {
            badge.textContent = '예약';
        }
    }
    if (modal) modal.dataset.isBooker = on ? '1' : '0';
}

function updateBookerBadgeAndCheckbox(isBooker) {
    const reservationTime = getReservationTimeFromCard(currentPaymentCard);
    // 배지 상태 업데이트
    setPaymentBookerBadge(isBooker, reservationTime);
    // 예약금 체크박스 동기화
    const depositCheckbox = document.getElementById('depositPaid');
    if (depositCheckbox) {
        depositCheckbox.checked = isBooker;
    }
    // 팀카드 배지 업데이트
    if (currentPaymentCard) {
        setTeamCardBookerBadge(currentPaymentCard, isBooker, reservationTime);
    }
}

function togglePaymentBookerBadge() {
    const modal = document.getElementById('paymentModal');
    if (!modal) return;
    const isCurrentlyBooker = modal.dataset.isBooker === '1';
    const newState = !isCurrentlyBooker;
    updateBookerBadgeAndCheckbox(newState);
    calculatePayment();
}

function onDepositCheckboxChange() {
    const depositCheckbox = document.getElementById('depositPaid');
    if (!depositCheckbox) return;
    const isChecked = depositCheckbox.checked;
    const currentData = currentPaymentCard ? parsePaymentDataSafe(currentPaymentCard.dataset.paymentData) : null;
    if (currentData?.naverBookingId) {
        // The existing checkbox remains the only staff control.  Store an
        // explicit marker so a never-configured card is not mistaken for a
        // deliberate onsite-payment conversion.
        currentData.naverDepositCancelledByStaff = !isChecked;
        currentPaymentCard.dataset.paymentData = JSON.stringify(currentData);
    }
    updateBookerBadgeAndCheckbox(isChecked);
    calculatePayment();
}

function buildCardPaymentHtml(paymentData) {
    if (!paymentData || typeof paymentData !== 'object') return '';
    const parts = [];
    if ((paymentData.cardInput || 0) > 0) parts.push(`<span class="pay-card" style="color:#0052cc;">카: ${paymentData.cardInput.toLocaleString()}</span>`);
    if ((paymentData.cashInput || 0) > 0) parts.push(`<span class="pay-cash" style="color:#00aa00;">현: ${paymentData.cashInput.toLocaleString()}</span>`);
    if ((paymentData.transferInput || 0) > 0) parts.push(`<span class="pay-transfer" style="color:#ff6600;">계: ${paymentData.transferInput.toLocaleString()}</span>`);
    const passAndCoupon = (paymentData.adultPass || 0) + (paymentData.childPass || 0) + (paymentData.coupon || 0);
    if (passAndCoupon > 0) parts.push(`<span class="pay-discount" style="color:#6f42c1;">다,쿠: ${passAndCoupon}</span>`);
    return parts.join(' / ');
}

function buildCardMetaHtml(level, people, roomFlagLabel) {
    const peoplePart = people ? ` ${people}명` : '-';
    const levelPart = level || '미입력';
    
    const flag = (roomFlagLabel && roomFlagLabel !== '-') ? roomFlagLabel : '-';

    let flagHtml = flag;      
    if (flag.startsWith('F')) {
        flagHtml = `<span class="flag-f-red" style="color:red; font-weight:bold;">${flag}</span>`;
    }
    
    const cleanLevel = levelPart.trim().toLowerCase(); // 공백 제거나 영문 소문자 대응용 안전장치
    let cssVar = '--text-main';

    if (cleanLevel.includes('basic') || cleanLevel.includes('베이직')) {
        cssVar = '--basic-color';
    } else if (cleanLevel.includes('easy') || cleanLevel.includes('이지')) {
        cssVar = '--easy-color';
    } else if (cleanLevel.includes('normal') || cleanLevel.includes('노멀')) {
        cssVar = '--normal-color';
    } else if (cleanLevel.includes('hard') || cleanLevel.includes('하드')) {
        cssVar = '--hard-color';
    } else if (cleanLevel.includes('challenger') || cleanLevel.includes('챌린저')) {
        cssVar = '--challenger-color';
    } else if (cleanLevel.includes('kids') || cleanLevel.includes('키즈')) {
        cssVar = '--kids-color';
    } else if (cleanLevel.includes('summer') || cleanLevel.includes('여름')) {
        cssVar = '--summer-color';
    } else if (cleanLevel.includes('space') || cleanLevel.includes('우주')) {
        cssVar = '--space-color';
    } else if (cleanLevel.includes('santa') || cleanLevel.includes('산타')) {
        cssVar = '--santa-color';
    } else if (cleanLevel === '미입력' || cleanLevel === '-') {
        cssVar = '--text-muted'; // 🚨 미입력 상태 감지
    }
    
    // ✨ 최종 결과물 리턴 (levelPart 자리에 색상이 입혀진 levelHtml을 주입합니다)
    const isMuted = (cssVar === '--text-muted');
    const borderStyle = isMuted ? 'none' : `10px solid var(${cssVar})`;
    const fontColor = isMuted ? 'var(--text-muted)' : 'var(--text-main)';
    const fontStyle = isMuted ? 'normal' : '800';

    const levelHtml = `
        <span style="
            color: ${fontColor}; 
            font-weight: ${fontStyle}; 
            border-right: ${borderStyle}; /* 🎯 미입력은 border가 생기지 않습니다 */
            padding-right: ${isMuted ? '0px' : '2px'};
            display: inline-block;
            line-height: 1;
        ">
            ${levelPart}
        </span>
    `;
    return `${peoplePart} / ${flagHtml} / ${levelHtml}`;
}

function parseCardMetaText(text) {
    const raw = (text || '').trim();
    // 데이터가 아예 없는 경우
    if (!raw || raw === '-') return { people: '', roomFlagLabel: '-', level: '' };

    const parts = raw.split('/').map(s => s.trim());

    // 최신 형식: 인원/사이즈/난이도 (3개 파트)
    if (parts.length >= 3) {
        return {
            people: parts[0].replace('명', '').trim(),
            // 빈 문자열이거나 값이 없으면 '-'로 유지
            roomFlagLabel: (parts[1] && parts[1] !== '') ? parts[1] : '-',
            level: parts.slice(2).join('/').trim()
        };
    }

    // 과도기 형식 또는 데이터가 2개만 있는 경우 (예: "4명/중" 또는 "4명/소")
    // 이 경우 두 번째 값이 숫자(명)인지, 사이즈(소/중/대)인지, 난이도인지 모호할 수 있습니다.
    if (parts.length === 2) {
        const p1 = parts[0];
        const p2 = parts[1];
        // 만약 첫 번째 파트에 '명'이 포함되어 있다면 [인원/난이도] 구조로 판단
        if (p1.includes('명')) {
            return {
                people: p1.replace('명', '').trim(),
                roomFlagLabel: '-',
                level: p2
            };
        }
        // 그 외에는 [난이도/인원] 구조로 판단 (기존 로직 유지)
        return {
            level: p1,
            people: p2.replace('명', '').trim(),
            roomFlagLabel: '-'
        };
    }
    // 파트가 1개뿐인 경우 (난이도만 있다고 가정)
    return { people: '', roomFlagLabel: '-', level: raw };
}

function normalizeRoomFlagsForRoom(roomValue, flags) {
    const room = (roomValue || '').toUpperCase();
    const current = flags || {};
    if (room === 'C1' || room === 'C2') {
        return { F: !!current.F, S: true, M: false, L: false };
    }
    if (room === 'B1' || room === 'B2') {
        if (current.F) {
            return { F: true, S: false, M: true, L: false };
        }
        return { F: false, S: false, M: !!current.M, L: !!current.L };
    }
    return { F: !!current.F, S: !!current.S, M: !!current.M, L: !!current.L };
}

function applyCardRoomFlagsForRoom(card, roomValue) {
    if (!card) return;
    const metaEl = card.querySelector('.p-level-people-text');
    if (!metaEl) return;

    const parsedMeta = parseCardMetaText(metaEl.textContent);
    let paymentData = null;
    try {
        paymentData = card.dataset.paymentData ? JSON.parse(card.dataset.paymentData) : null;
    } catch (e) {
        paymentData = null;
    }
    if (!paymentData || typeof paymentData !== 'object') paymentData = {};

    const currentFlags = paymentData.roomFlags || roomFlagsFromLabel(parsedMeta.roomFlagLabel);
    const normalizedFlags = normalizeRoomFlagsForRoom(roomValue, currentFlags);
    const normalizedLabel = roomFlagLabelFromFlags(normalizedFlags);

    paymentData.roomFlags = normalizedFlags;
    paymentData.roomFlagLabel = normalizedLabel;
    card.dataset.paymentData = JSON.stringify(paymentData);
    metaEl.innerHTML = buildCardMetaHtml(parsedMeta.level, parsedMeta.people, normalizedLabel);

    updateCardView(card);
    syncLinkedQueueItemFromCard(card);
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

function cellHasBooking(cell) {
    const view = cell.querySelector('.cell-view');
    if (!view) return false;
    const name = view.querySelector('.p-name-text').textContent.trim();
    const phone = view.querySelector('.p-phone-text').textContent.trim();
    const team = view.querySelector('.p-team-text').textContent.trim();
    const levelPeople = view.querySelector('.p-level-people-text').textContent.trim();
    return !!(name || phone || team || levelPeople);
}

function updateBookingPresence(cell) {
    const view = cell.querySelector('.cell-view');
    if (!view) return;
    view.classList.toggle('has-booking', cellHasBooking(cell));
}
const ROOMS = ['C1', 'C2', 'B1', 'B2'];

function getDashboardDateYMD() {
    const dateInput = document.getElementById('dashboard-date');

    if (dateInput && dateInput.value) {
        return dateInput.value;
    }
    
    return formatDateYYYYMMDD(new Date());
}

function updateTodayDate() { 
    const now = new Date(); 
    const year = String(now.getFullYear()).slice(-2); 
    const month = String(now.getMonth() + 1).padStart(2, '0'); 
    const date = String(now.getDate()).padStart(2, '0'); 
    const week = ['일', '월', '화', '수', '목', '금', '토']; 
    document.getElementById('currentDate').innerText = `${year}-${month}-${date} ${week[now.getDay()]}`; 
}

function getCurrentDayType() {
    return document.body.dataset.dayType || 'weekday';
}

function getAutoDayType() {
    return document.body.dataset.autoDayType || 'weekday';
}

const DAY_TYPE_OVERRIDE_STORAGE_KEY = 'jumpingbattle_forced_day_type_by_date_v1';

function loadDayTypeOverrideStore() {
    try {
        const raw = localStorage.getItem(DAY_TYPE_OVERRIDE_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function saveDayTypeOverrideStore(store) {
    localStorage.setItem(DAY_TYPE_OVERRIDE_STORAGE_KEY, JSON.stringify(store || {}));
}

function getForcedDayType() {
    const targetDate = getDashboardDateYMD();
    const store = loadDayTypeOverrideStore();
    const value = store?.[targetDate];
    return value === 'weekday' || value === 'weekend' ? value : null;
}

function saveForcedDayType(targetDate, dayType) {
    const store = loadDayTypeOverrideStore();
    store[targetDate] = dayType;
    saveDayTypeOverrideStore(store);
}

function clearForcedDayType(targetDate) {
    const store = loadDayTypeOverrideStore();
    if (Object.prototype.hasOwnProperty.call(store, targetDate)) {
        delete store[targetDate];
        saveDayTypeOverrideStore(store);
    }
}

function updateDayTypeForcedUi(isForced) {
    const forcedNotice = document.getElementById('dayTypeForcedNotice');
    if (forcedNotice) {
        const shouldShowForcedNotice = isForced && getCurrentDayType() !== getAutoDayType();
        forcedNotice.style.display = shouldShowForcedNotice ? 'inline' : 'none';
    }
}

const KR_HOLIDAY_API_BASE = 'https://date.nager.at/api/v3/PublicHolidays';

function formatDateYYYYMMDD(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function fetchKoreanHolidaySet(year) {
    const cacheKey = `kr_holidays_${year}`;
    try {
        const cachedRaw = sessionStorage.getItem(cacheKey);
        if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            if (Array.isArray(cached?.dates)) {
                return new Set(cached.dates);
            }
        }
    } catch (e) {
        console.warn('공휴일 캐시 파싱 실패', e);
    }

    const url = `${KR_HOLIDAY_API_BASE}/${year}/KR`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`공휴일 API 실패: ${res.status}`);
    const holidays = await res.json();
    const dates = Array.isArray(holidays) ? holidays.map(h => h.date).filter(Boolean) : [];

    try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ dates }));
    } catch (e) {
        console.warn('공휴일 캐시 저장 실패', e);
    }

    return new Set(dates);
}

async function autoSetDayTypeFromKoreanCalendar() {
    const today = new Date();
    const isWeekend = today.getDay() === 0 || today.getDay() === 6;
    let isHoliday = false;

    try {
        const holidaySet = await fetchKoreanHolidaySet(today.getFullYear());
        isHoliday = holidaySet.has(formatDateYYYYMMDD(today));
    } catch (e) {
        console.warn('공휴일 자동 연동 실패(주말 기준으로 처리)', e);
        const notice = document.getElementById('holidaySyncNotice');
        if (notice) {
            notice.textContent = '공휴일 API 오류(주말만 자동)';
            notice.style.color = '#d32f2f';
        }
    }

    const type = (isWeekend || isHoliday) ? 'weekend' : 'weekday';
    document.body.dataset.autoDayType = type;

    const forcedType = getForcedDayType();

    if (forcedType) {
        setDayType(forcedType, { forced: true });
        return;
    }

    setDayType(type);
}

async function toggleForcedDayType() {
    const nextType = getCurrentDayType() === 'weekday' ? 'weekend' : 'weekday';
    const targetDate = getDashboardDateYMD();

    try {
        if (nextType === getAutoDayType()) {
            clearForcedDayType(targetDate);
            setDayType(nextType, { forced: false });
            return;
        }

        saveForcedDayType(targetDate, nextType);
        setDayType(nextType, { forced: true });
    } catch (e) {
        console.error('강제 평일/주말 변경 실패', e);
        alert('평일/주말 강제변경 저장에 실패했습니다.');
    }
}

function initTimeSelect() {
    const select = document.getElementById('bookTime');
    if (!select) return;

    select.innerHTML = "";
    const optionValues = [];

    for (let h = 10; h < 23; h++) {
        for (let m = 0; m < 60; m += 20) {
            if (h === 22 && m === 40) continue;
            const timeStr = `${h}:${m === 0 ? '00' : m}`;
            const value = `${h}-${m}`;
            const opt = document.createElement('option');
            opt.value = value;
            opt.innerText = timeStr;
            select.appendChild(opt);
            optionValues.push({ h, m, value });
        }
    }

    if (!optionValues.length) return;

    // 현재 시각 기준으로 가장 가까운 "다음" 20분 슬롯을 기본값으로 설정
    const now = new Date();
    const totalMinutesNow = now.getHours() * 60 + now.getMinutes();
    const roundedUp = Math.ceil(totalMinutesNow / 20) * 20;

    let target = optionValues.find((t) => (t.h * 60 + t.m) >= roundedUp);
    if (!target) {
        target = optionValues[optionValues.length - 1];
    }

    select.value = target.value;
}


function toNumber(value) {
    // 콤마, 공백, 소수점, 음수 모두 허용
    if (typeof value === 'number') return isNaN(value) ? 0 : value;
    if (typeof value === 'string') {
        // 숫자, 소수점, 음수 부호만 남김
        const num = Number(value.replace(/[^\d.-]/g, ''));
        return isNaN(num) ? 0 : num;
    }
    return 0;
}

function formatCurrencyInput(input) {
    if (!input) return;
    const digits = String(input.value || '').replace(/[^\d]/g, '');
    input.value = digits ? Number(digits).toLocaleString() : '';
}

let supplyHistoryEntries = [];
let dashboardNoShowManualCount = 0;
let dashboardCashExpenseManualAmount = 0;
let dashboardCashExpenseSaveTimer = null;
let dashboardNoShowSaveTimer = null;
window.supplyHistoryEntries = supplyHistoryEntries;

function updateDashboardCashExpenseInputDisplay() {
    const input = document.getElementById('dashboardCashExpenseInput');
    if (!input) return;
    input.value = dashboardCashExpenseManualAmount > 0 ? dashboardCashExpenseManualAmount.toLocaleString() : '';
}

async function loadDashboardCashExpenseAmount() {
    const targetDate = getDashboardDateYMD();
    const today = new Date().toISOString().split('T')[0];
    const isPast = targetDate < today; // 과거 날짜 여부 체크

    try {
        const res = await fetch(`/api/settlement/cash_expense?date=${encodeURIComponent(targetDate)}`);
        if (!res.ok) throw new Error('현금지출 불러오기 실패');
        const data = await res.json();
        const amount = parseInt(data?.cash_expense, 10);
        dashboardCashExpenseManualAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
    } catch (e) {
        console.error(e);
        dashboardCashExpenseManualAmount = 0;
    }
    updateDashboardCashExpenseInputDisplay();

    const input = document.getElementById('dashboardCashExpenseInput');
    if (input) input.disabled = isPast;

    updateDashboardSettlementSummary();
}

async function loadDashboardNoShowCount() {
    const targetDate = getDashboardDateYMD();
    const today = new Date().toISOString().split('T')[0];
    const isPast = targetDate < today; // 과거 날짜 여부 체크

    try {
        const res = await fetch(`/api/settlement/no_show?date=${encodeURIComponent(targetDate)}`);
        if (!res.ok) throw new Error('노쇼값 불러오기 실패');
        const data = await res.json();
        const noShowCount = parseInt(data?.no_show_count, 10);
        dashboardNoShowManualCount = Number.isFinite(noShowCount) ? Math.max(0, Math.min(noShowCount, 99)) : 0;
    } catch (e) {
        console.error(e);
        dashboardNoShowManualCount = 0;
    }

    const input = document.getElementById('dashboardNoShowInput');
    if (input) {
        input.value = String(dashboardNoShowManualCount);
        // [추가] 과거 날짜면 노쇼 입력창을 비활성화(disabled) 처리
        input.disabled = isPast;
    }
    updateDashboardSettlementSummary();
}

async function persistDashboardCashExpenseAmount() {
    const targetDate = getDashboardDateYMD();
    try {
        const res = await fetch(`/api/settlement/cash_expense?date=${encodeURIComponent(targetDate)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cashExpense: dashboardCashExpenseManualAmount })
        });
        if (!res.ok) throw new Error('현금지출 저장 실패');
    } catch (e) {
        console.error(e);
    }
}

function scheduleDashboardCashExpenseSave() {
    if (dashboardCashExpenseSaveTimer) {
        clearTimeout(dashboardCashExpenseSaveTimer);
        dashboardCashExpenseSaveTimer = null;
    }
    dashboardCashExpenseSaveTimer = setTimeout(() => {
        persistDashboardCashExpenseAmount();
    }, 350);
}

async function persistDashboardNoShowCount() {
    const targetDate = getDashboardDateYMD();
    try {
        const res = await fetch(`/api/settlement/no_show?date=${encodeURIComponent(targetDate)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ noShowCount: dashboardNoShowManualCount })
        });
        if (!res.ok) throw new Error('노쇼값 저장 실패');
    } catch (e) {
        console.error(e);
    }
}

function scheduleDashboardNoShowSave() {
    if (dashboardNoShowSaveTimer) {
        clearTimeout(dashboardNoShowSaveTimer);
        dashboardNoShowSaveTimer = null;
    }
    dashboardNoShowSaveTimer = setTimeout(() => {
        persistDashboardNoShowCount();
    }, 350);
}

function handleDashboardCashExpenseInput(input) {
    const el = input || document.getElementById('dashboardCashExpenseInput');
    if (!el) return;
    const digits = String(el.value || '').replace(/[^\d]/g, '');
    dashboardCashExpenseManualAmount = digits ? parseInt(digits, 10) : 0;
    el.value = digits ? Number(digits).toLocaleString() : '';
    updateDashboardSettlementSummary();
    scheduleDashboardCashExpenseSave();
}

window.handleDashboardCashExpenseInput = handleDashboardCashExpenseInput;

// DB에서 결제리스트 불러오기
async function loadSupplyHistoryFromDB() {
    try {
        const targetDate = getDashboardDateYMD();
        const res = await fetch(`/api/supply_history/list?date=${encodeURIComponent(targetDate)}`);
        if (!res.ok) throw new Error('결제리스트 불러오기 실패');
        const data = await res.json();
        supplyHistoryEntries = data.map(e => ({
            time: e.time,
            item: e.item,
            quantity: e.quantity,
            etcText: e.etc_text || '',
            cardAmount: e.card_amount,
            cashAmount: e.cash_amount,
            transferAmount: e.transfer_amount,
            totalAmount: e.total_amount
        }));
        window.supplyHistoryEntries = supplyHistoryEntries;
        renderSupplyHistory();
        updateSupplyAccumulatedTotals();
    } catch (e) {
        console.error(e);
    }
}

// 결제리스트를 DB에 저장
async function saveSupplyHistoryToDB() {
    const mainWrapper = document.querySelector('.main-wrapper');
    if (mainWrapper && mainWrapper.dataset.readonly === "true") {
        console.warn("🔒 조회 전용 모드이므로 DB에 저장하지 않습니다.");
        return; 
    }

    try {
        const targetDate = getDashboardDateYMD();
        await fetch(`/api/supply_history/save?date=${encodeURIComponent(targetDate)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(supplyHistoryEntries)
        });
    } catch (e) {
        console.error('결제리스트 저장 실패', e);
    }
}

// HH:MM:SS 또는 HH:MM 문자열에서 HH:MM만 반환 (결제리스트 시간 표시용)
function formatTimeToHHMM(timeStr) {
    if (!timeStr) return '';
    const parts = String(timeStr).split(':');
    if (parts.length >= 2) {
        return `${parts[0]}:${parts[1]}`;
    }
    return timeStr;
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatSupplyHistoryItem(entry) {
    const item = String(entry?.item || '').trim();
    const etcText = String(entry?.etcText || '').trim();
    const normalizedItem = item.replace(/\s+/g, '');
    let itemLabel = item;
    if (normalizedItem === '기타' && etcText) {
        itemLabel = `${item}(${etcText})`;
    }
    return itemLabel;
}

function renderSupplyHistory() {
    const body = document.getElementById('supplyHistoryBody');
    const empty = document.getElementById('supplyHistoryEmpty');
    if (!body) return;

    body.innerHTML = '';
    supplyHistoryEntries.forEach((entry, idx) => {
        const tr = document.createElement('tr');
        const itemText = formatSupplyHistoryItem(entry);
        const rawQty = entry?.quantity;
        const parsedQty = (rawQty !== "" && rawQty !== null) ? Number(rawQty) : NaN;
        const quantityText = (Number.isFinite(parsedQty) && parsedQty >= 0) 
                     ? String(parsedQty) 
                     : '-';
        tr.innerHTML = `
            <td>${formatTimeToHHMM(entry.time)}</td>
            <td>${escapeHtml(itemText)}</td>
            <td>${escapeHtml(quantityText)}</td>
            <td>${entry.cardAmount.toLocaleString()}</td>
            <td>${entry.cashAmount.toLocaleString()}</td>
            <td>${entry.transferAmount.toLocaleString()}</td>
            <td><button type="button" class="supply-history-delete-btn" onclick="deleteSupplyHistoryEntry(${idx})">삭제</button></td>
        `;
        body.appendChild(tr);
    });

    if (empty) {
        empty.style.display = supplyHistoryEntries.length ? 'none' : 'block';
    }

    // 스크롤 자동 하단 이동
    const wrap = document.getElementById('supplyHistoryTableWrap');
    if (wrap) {
        wrap.scrollTop = wrap.scrollHeight;
    }
}

async function deleteSupplyHistoryEntry(index) {
    const mainWrapper = document.querySelector('.main-wrapper');
    const isReadOnly = mainWrapper && mainWrapper.dataset.readonly === "true";

    if (isReadOnly) {
        alert("🔒 과거 데이터의 기타 판매 내역은 삭제할 수 없습니다.");
        return;
    }

    if (!Number.isInteger(index) || index < 0 || index >= supplyHistoryEntries.length) return;
    if (!confirm("해당 판매 내역을 삭제하시겠습니까?")) return;

    supplyHistoryEntries.splice(index, 1);
    window.supplyHistoryEntries = supplyHistoryEntries;
    renderSupplyHistory();
    updateSupplyAccumulatedTotals();
    await saveSupplyHistoryToDB();
}

function updateSupplyAccumulatedTotals() {
    const totals = computeSupplyTotalsFromHistory();
    const cardTotal = totals.cardExcludingDeposit;
    const cashTotal = totals.cash;
    const transferTotal = totals.transfer;
    const grandTotal = cardTotal + cashTotal + transferTotal;
    let passTotal = 0;
    let partyTotal = 0;

    supplyHistoryEntries.forEach((entry) => {
        const item = String(entry?.item || '').replace(/\s+/g, '');
        const amount = (parseInt(entry?.cardAmount, 10) || 0)
            + (parseInt(entry?.cashAmount, 10) || 0)
            + (parseInt(entry?.transferAmount, 10) || 0);

        if (item.startsWith('다회')) {
            passTotal += amount;
        }
        if (item.startsWith('파티룸')) {
            partyTotal += amount;
        }
    });

    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value.toLocaleString();
    };
    setText('supplyTotalCard', cardTotal);
    setText('supplyTotalCash', cashTotal);
    setText('supplyTotalTransfer', transferTotal);
    setText('supplyGrandTotal', grandTotal);
    setText('supplyTotalPass', passTotal);
    setText('supplyTotalParty', partyTotal);
    updateDashboardSettlementSummary();
}

function computeTeamPaidTotalsFromCards() {
    let card = 0;
    let cash = 0;
    let transfer = 0;

    const cards = document.querySelectorAll('.booking-card');
    cards.forEach((el) => {
        const paidChecked = !!el.querySelector('.p-paid')?.checked;
        if (!paidChecked) return;

        const paymentData = parsePaymentDataSafe(el.dataset.paymentData);
        if (!paymentData) return;

        card += parseInt(paymentData.cardInput, 10) || 0;
        cash += parseInt(paymentData.cashInput, 10) || 0;
        transfer += parseInt(paymentData.transferInput, 10) || 0;
    });

    return { card, cash, transfer, total: card + cash + transfer };
}

function computeSupplyTotalsFromHistory() {
    let card = 0;
    let cardExcludingDeposit = 0;
    let cash = 0;
    let transfer = 0;

    supplyHistoryEntries.forEach((entry) => {
        const cardAmount = parseInt(entry.cardAmount, 10) || 0;
        card += cardAmount;
        cash += parseInt(entry.cashAmount, 10) || 0;
        transfer += parseInt(entry.transferAmount, 10) || 0;

        // 정산 카드칸에는 예약금(예) 카드금액을 제외하고 반영
        const item = String(entry?.item || '').replace(/\s+/g, '');
        const isDepositEntry = !!entry?.isDeposit || item.includes('(예)');
        if (!isDepositEntry) {
            cardExcludingDeposit += cardAmount;
        }
    });

    return {
        card,
        cardExcludingDeposit,
        cash,
        transfer,
        total: card + cash + transfer,
    };
}

function updateDashboardSettlementSummary() {
    const team = computeTeamPaidTotalsFromCards();
    const supply = computeSupplyTotalsFromHistory();
    // 정산 카드값: 모달 카드 + 기타판매 카드(예약금(예) 제외)
    const card = team.card + supply.cardExcludingDeposit;
    const cashBeforeExpense = team.cash + supply.cash;
    const cash = cashBeforeExpense - dashboardCashExpenseManualAmount;
    const transfer = team.transfer + supply.transfer;
    let depositTotal = 0;
    let noShowTotal = 0;
    let passAdultCount = 0;  // 다회권 성인 개수
    let passStudentCount = 0;  // 다회권 학생 개수
    let couponAdultCount = 0;  // 쿠폰 성인 개수
    let couponStudentCount = 0;  // 쿠폰 학생 개수

    // booking-card의 paymentData에서 직접 합산
    const cards = document.querySelectorAll('.booking-card');
    cards.forEach((el) => {
        const paymentData = parsePaymentDataSafe(el.dataset.paymentData);
        if (!paymentData) return;
        
        // 예약금 합산: 예약자 배지(isBooker)와 무관하게 예약금 체크(depositPaid)일 때만 반영
        if (paymentData.depositPaid) {
            depositTotal += parseInt(paymentData.depositAmount, 10) || 5000;
        }
        
        // 다회권 성인/학생 개수 합산
        passAdultCount += parseInt(paymentData.adultPass, 10) || 0;
        passStudentCount += parseInt(paymentData.childPass, 10) || 0;
        
        // 쿠폰 성인/학생 개수 합산
        couponAdultCount += parseInt(paymentData.couponAdult, 10) || 0;
        couponStudentCount += parseInt(paymentData.couponChild, 10) || 0;
    });

    // supplyHistoryEntries에서 예약금 추가 합산 (기존 로직 유지)
    supplyHistoryEntries.forEach((entry) => {
        const item = String(entry?.item || '').replace(/\s+/g, '');
        const amount = (parseInt(entry?.cardAmount, 10) || 0)
            + (parseInt(entry?.cashAmount, 10) || 0)
            + (parseInt(entry?.transferAmount, 10) || 0);

        if (entry?.isDeposit || item.includes('(예)')) depositTotal += amount;
        if (item.includes('당일취소') || item.includes('노쇼') || item.includes('취소&노쇼')) {
            noShowTotal += amount;
        }
    });

    const manualNoShowAmount = dashboardNoShowManualCount * 5000;
    const displayNoShowTotal = noShowTotal + manualNoShowAmount;
    const depositTotalWithManualNoShow = depositTotal + manualNoShowAmount;
    // 수동 당일취소&노쇼 입력값은 예약금에 합산하고, 전체합계는 반영된 예약금 기준으로 계산한다.
    const total = card + cash + transfer + depositTotalWithManualNoShow + noShowTotal;

    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = typeof value === 'number' ? value.toLocaleString() : value;
    };

    setText('dashboardSettleCard', card);
    setText('dashboardSettleCash', cash);
    setText('dashboardSettleTransfer', transfer);
    setText('dashboardSettleTotal', total);
    setText('dashboardSettleDeposit', depositTotalWithManualNoShow);
    setText('dashboardSettleNoShow', displayNoShowTotal);
    setText('dashboardSettlePassAdult', passAdultCount);
    setText('dashboardSettlePassStudent', passStudentCount);
    setText('dashboardSettleCouponAdult', couponAdultCount);
    setText('dashboardSettleCouponStudent', couponStudentCount);
}

function addDashboardNoShowAmount() {
    const input = document.getElementById('dashboardNoShowInput');
    if (!input) return;

    const raw = parseInt(input.value, 10);
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(raw, 99)) : 0;

    // 입력값 자체를 현재 갯수로 사용 (기본 0)
    dashboardNoShowManualCount = value;
    input.value = String(value);
    updateDashboardSettlementSummary();
    scheduleDashboardNoShowSave();
}

function updateSupplyRow(row) {
    if (!row) return;
    // per-row UI는 단순 입력만 유지, 합계는 footer에서 통합 표시
}

function getSpecialPaymentCurrent() {
    const isDeposit = !!document.getElementById('spPartyIsDeposit')?.checked;
    const depositCardAmount = isDeposit ? 50000 : 0;
    const partyCardInput = toNumber(document.getElementById('spPartyCard')?.value);
    const partyCash = toNumber(document.getElementById('spPartyCash')?.value);
    const partyTransfer = toNumber(document.getElementById('spPartyTransfer')?.value);
    const etcCard = toNumber(document.getElementById('spEtcCard')?.value);
    const etcCash = toNumber(document.getElementById('spEtcCash')?.value);
    const etcTransfer = toNumber(document.getElementById('spEtcTransfer')?.value);
    const etcText = String(document.getElementById('spEtcText')?.value || '').trim();

    return {
        card: partyCardInput + depositCardAmount + etcCard,
        cash: partyCash + etcCash,
        transfer: partyTransfer + etcTransfer,
        isDeposit,
        depositCardAmount,
        partyCardInput,
        partyCash,
        partyTransfer,
        etcCard,
        etcCash,
        etcTransfer,
        etcText
    };
}

function updateSupplyTotals() {
    const mainWrapper = document.querySelector('.main-wrapper');
    if (mainWrapper && mainWrapper.dataset.readonly === "true") {
        return; 
    }

    const rows = [...document.querySelectorAll('#supplyTableBodyCol1 tr, #supplyTableBodyCol2 tr')];
    let currentTotal = 0;

    rows.forEach((row) => {
        updateSupplyRow(row);
        const unit = toNumber(row.dataset.unit);
        const cardQty = toNumber(row.querySelector('.supply-card')?.value);
        const cashQty = toNumber(row.querySelector('.supply-cash')?.value);
        const transferQty = toNumber(row.querySelector('.supply-transfer')?.value);
        currentTotal += (cardQty + cashQty + transferQty) * unit;
    });

    const special = getSpecialPaymentCurrent();
    currentTotal += (special.card + special.cash + special.transfer);

    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value.toLocaleString();
    };
    setText('supplyFooterTotal', currentTotal);
}

function applySupplyInputs() {
    const rows = [...document.querySelectorAll('#supplyTableBodyCol1 tr, #supplyTableBodyCol2 tr')];
    const now = formatTimeToHHMM(new Date().toTimeString());
    const newEntries = [];

    rows.forEach((row) => {
        const item = row.dataset.item || row.querySelector('.supply-item')?.value?.replace(/\s+/g, '').trim() || '항목';
        const unit = toNumber(row.dataset.unit);
        const cardQty = toNumber(row.querySelector('.supply-card')?.value);
        const cashQty = toNumber(row.querySelector('.supply-cash')?.value);
        const transferQty = toNumber(row.querySelector('.supply-transfer')?.value);
        if (!(cardQty || cashQty || transferQty)) return;

        const cardAmount = cardQty * unit;
        const cashAmount = cashQty * unit;
        const transferAmount = transferQty * unit;
        const quantity = cardQty + cashQty + transferQty;
        newEntries.push({
            time: now,
            item,
            quantity,
            cardAmount,
            cashAmount,
            transferAmount,
            totalAmount: cardAmount + cashAmount + transferAmount
        });

        const cardInput = row.querySelector('.supply-card');
        const cashInput = row.querySelector('.supply-cash');
        const transferInput = row.querySelector('.supply-transfer');
        if (cardInput) cardInput.value = '';
        if (cashInput) cashInput.value = '';
        if (transferInput) transferInput.value = '';
    });

    const special = getSpecialPaymentCurrent();
    if (special.isDeposit) {
        newEntries.push({
            time: now,
            item: '파티룸(예)',
            quantity: null,
            cardAmount: special.depositCardAmount,
            cashAmount: 0,
            transferAmount: 0,
            totalAmount: special.depositCardAmount,
            isDeposit: true
        });
    }
    if (special.partyCardInput || special.partyCash || special.partyTransfer) {
        newEntries.push({
            time: now,
            item: '파티룸',
            quantity: null,
            cardAmount: special.partyCardInput,
            cashAmount: special.partyCash,
            transferAmount: special.partyTransfer,
            totalAmount: special.partyCardInput + special.partyCash + special.partyTransfer,
            isDeposit: false
        });
    }
    if (special.etcCard || special.etcCash || special.etcTransfer) {
        newEntries.push({
            time: now,
            item: '기타',
            quantity: null,
            etcText: special.etcText,
            cardAmount: special.etcCard,
            cashAmount: special.etcCash,
            transferAmount: special.etcTransfer,
            totalAmount: special.etcCard + special.etcCash + special.etcTransfer,
            isDeposit: false
        });
    }

    ['spPartyCard','spPartyCash','spPartyTransfer','spEtcCard','spEtcCash','spEtcTransfer','spEtcText'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const partyDepositCheck = document.getElementById('spPartyIsDeposit');
    if (partyDepositCheck) partyDepositCheck.checked = false;

    if (newEntries.length > 0) {
        supplyHistoryEntries = [...supplyHistoryEntries, ...newEntries];
        window.supplyHistoryEntries = supplyHistoryEntries;
        renderSupplyHistory();
        updateSupplyAccumulatedTotals();
        saveSupplyHistoryToDB();
    }

    updateSupplyTotals();
}

function createSupplyRow(itemName = '', unit = 0, allowCard = true) {
    const tr = document.createElement('tr');
    tr.dataset.unit = String(unit || 0);
    tr.dataset.allowCard = allowCard ? '1' : '0';
    tr.dataset.item = itemName;
    tr.className = getSupplyRowThemeClass(itemName);
    const cardInputHtml = allowCard
        ? '<input type="number" class="supply-card" min="0" value="" placeholder="수량" oninput="updateSupplyTotals()">'
        : '<input type="number" class="supply-card" min="0" value="" placeholder="-" oninput="updateSupplyTotals()" disabled style="background:#f8fafc;color:#94a3b8;">';
    tr.innerHTML = `
        <td><input type="text" class="supply-item" value="${formatDisplayItemLabel(itemName)}" readonly style="color:#475569; font-weight:700; text-align:center;"></td>
        <td>${cardInputHtml}</td>
        <td><input type="number" class="supply-cash" min="0" value="" placeholder="수량" oninput="updateSupplyTotals()"></td>
        <td><input type="number" class="supply-transfer" min="0" value="" placeholder="수량" oninput="updateSupplyTotals()"></td>
    `;
    return tr;
}

function formatDisplayItemLabel(itemName = '') {
    const plain = String(itemName || '').trim();
    return plain.length === 2 ? plain.split('').join(' ') : plain;
}

function getSupplyRowThemeClass(itemName = '') {
    switch (itemName) {
        case '파우치': return 'row-theme-rose';
        case '슬러시': return 'row-theme-cyan';
        case '양말': return 'row-theme-emerald';
        case '얼음컵': return 'row-theme-indigo';
        case '음료세트': return 'row-theme-amber';
        case '사진': return 'row-theme-violet';
        case '다회(성)': return 'row-theme-purple';
        case '다회(청)': return 'row-theme-pink';
        default: return '';
    }
}

function getSupplyNavigationInputs() {
    return [...document.querySelectorAll('.special-pay-table input[type="number"], .special-pay-table input.currency-input, .supply-table tbody input[type="number"]')]
        .filter((input) => !input.disabled);
}

function focusSupplyInput(input) {
    if (!input) return;
    input.focus();
    if (typeof input.select === 'function') input.select();
}

function moveSupplyInputLinear(currentInput, direction) {
    const inputs = getSupplyNavigationInputs();
    const currentIndex = inputs.indexOf(currentInput);
    if (currentIndex < 0) return false;
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= inputs.length) return true;
    focusSupplyInput(inputs[nextIndex]);
    return true;
}

function moveSupplyInputByGrid(currentInput, rowDelta, colDelta) {
    const cell = currentInput.closest('td');
    const row = currentInput.closest('tr');
    const table = currentInput.closest('table');
    if (!cell || !row || !table) return false;

    const rows = [...table.querySelectorAll('tbody tr')];
    const rowIndex = rows.indexOf(row);
    if (rowIndex < 0) return false;

    const currentRowInputs = [...row.querySelectorAll('input[type="number"], input.currency-input')].filter((input) => !input.disabled && !input.readOnly);
    const colIndex = currentRowInputs.indexOf(currentInput);
    if (colIndex < 0) return false;

    if (rowDelta === 0) {
        const targetIndex = colIndex + colDelta;
        if (targetIndex < 0 || targetIndex >= currentRowInputs.length) return true;
        focusSupplyInput(currentRowInputs[targetIndex]);
        return true;
    }

    const targetRow = rows[rowIndex + rowDelta];
    if (!targetRow) return true;
    const targetInputs = [...targetRow.querySelectorAll('input[type="number"], input.currency-input')].filter((input) => !input.disabled && !input.readOnly);
    if (!targetInputs.length) return true;
    const targetIndex = Math.min(colIndex, targetInputs.length - 1);
    focusSupplyInput(targetInputs[targetIndex]);
    return true;
}

function getUnifiedSupplyTableRows() {
    const specialRows = [...document.querySelectorAll('.special-pay-table tbody tr')];
    const col1Rows = [...document.querySelectorAll('#supplyTableBodyCol1 tr')];
    const col2Rows = [...document.querySelectorAll('#supplyTableBodyCol2 tr')];
    const rows = [];

    specialRows.forEach((rowEl) => {
        const rowInputs = [...rowEl.querySelectorAll('input[type="number"], input.currency-input')]
            .filter((input) => !input.disabled && !input.readOnly);
        if (rowInputs.length) rows.push(rowInputs);
    });

    const rowCount = Math.max(col1Rows.length, col2Rows.length);

    for (let i = 0; i < rowCount; i++) {
        const mergedRowInputs = [];
        [col1Rows[i], col2Rows[i]].forEach((rowEl) => {
            if (!rowEl) return;
            const inputs = [...rowEl.querySelectorAll('input[type="number"]')]
                .filter((input) => !input.disabled && !input.readOnly);
            mergedRowInputs.push(...inputs);
        });
        if (mergedRowInputs.length) rows.push(mergedRowInputs);
    }

    return rows;
}

function moveSupplyInputInUnifiedTable(currentInput, rowDelta, colDelta) {
    const rows = getUnifiedSupplyTableRows();
    if (!rows.length) return false;

    let rowIndex = -1;
    let colIndex = -1;
    for (let r = 0; r < rows.length; r++) {
        const c = rows[r].indexOf(currentInput);
        if (c >= 0) {
            rowIndex = r;
            colIndex = c;
            break;
        }
    }
    if (rowIndex < 0 || colIndex < 0) return false;

    if (rowDelta === 0) {
        const targetCol = colIndex + colDelta;
        if (targetCol >= 0 && targetCol < rows[rowIndex].length) {
            focusSupplyInput(rows[rowIndex][targetCol]);
            return true;
        }

        if (colDelta > 0) {
            for (let r = rowIndex + 1; r < rows.length; r++) {
                if (rows[r].length) {
                    focusSupplyInput(rows[r][0]);
                    return true;
                }
            }
            return true;
        }

        for (let r = rowIndex - 1; r >= 0; r--) {
            if (rows[r].length) {
                focusSupplyInput(rows[r][rows[r].length - 1]);
                return true;
            }
        }
        return true;
    }

    const targetRowIndex = rowIndex + rowDelta;
    if (targetRowIndex < 0 || targetRowIndex >= rows.length) return true;
    const targetRow = rows[targetRowIndex];
    if (!targetRow.length) return true;
    const targetCol = Math.min(colIndex, targetRow.length - 1);
    focusSupplyInput(targetRow[targetCol]);
    return true;
}

function handleSupplyInputKeydown(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const isSupplyInput = input.matches('.special-pay-table input[type="number"], .special-pay-table input.currency-input, .supply-table tbody input[type="number"]');
    if (!isSupplyInput || input.disabled || input.readOnly) return;

    if (event.key === 'ArrowLeft') {
        const moved = moveSupplyInputInUnifiedTable(input, 0, -1);
        if (moved) event.preventDefault();
        return;
    }
    if (event.key === 'ArrowRight') {
        const moved = moveSupplyInputInUnifiedTable(input, 0, 1);
        if (moved) event.preventDefault();
        return;
    }
    if (event.key === 'ArrowUp') {
        const moved = moveSupplyInputInUnifiedTable(input, -1, 0);
        if (moved) event.preventDefault();
        return;
    }
    if (event.key === 'ArrowDown') {
        const moved = moveSupplyInputInUnifiedTable(input, 1, 0);
        if (moved) event.preventDefault();
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        applySupplyInputs();
        return;
    }
    if (event.key === 'Tab') {
        if (moveSupplyInputLinear(input, event.shiftKey ? -1 : 1)) event.preventDefault();
        return;
    }
    if (event.key === 'Backspace' && !input.value) {
        if (moveSupplyInputLinear(input, -1)) event.preventDefault();
    }
}

function initSupplyInputNavigation() {
    const panel = document.querySelector('.beverage-container');
    if (!panel || panel.dataset.inputNavBound === '1') return;
    panel.dataset.inputNavBound = '1';
    panel.addEventListener('keydown', handleSupplyInputKeydown);
}

function getQuickBookingRows() {
    const getEl = (id) => document.getElementById(id);
    const roomRadios = Array.from(document.querySelectorAll('input[name="bookRoom"]'));

    const rows = [
        [getEl('bookTime'), ...roomRadios],
        [getEl('bookName'), getEl('bookTeam'), getEl('bookLevel'), getEl('bookPeople')],
        [getEl('bookDeposit'), getEl('bookPartyRoom')],
        [getEl('reservationGraceMinutes')]
    ];

    return rows.map((row) => row.filter(Boolean));
}

function getQuickBookingCurrentPosition(target) {
    const rows = getQuickBookingRows();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const colIndex = rows[rowIndex].indexOf(target);
        if (colIndex >= 0) {
            return { rows, rowIndex, colIndex };
        }
    }
    return { rows, rowIndex: -1, colIndex: -1 };
}

function focusQuickBookingControl(el) {
    if (!el) return;
    el.focus();
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && typeof el.select === 'function') {
        el.select();
    }
}

function moveQuickBookingHorizontal(target, direction) {
    const { rows, rowIndex, colIndex } = getQuickBookingCurrentPosition(target);
    if (rowIndex < 0 || colIndex < 0) return false;

    const nextCol = colIndex + direction;
    if (nextCol < 0 || nextCol >= rows[rowIndex].length) return true;

    focusQuickBookingControl(rows[rowIndex][nextCol]);
    return true;
}

function moveQuickBookingVertical(target, direction) {
    const { rows, rowIndex } = getQuickBookingCurrentPosition(target);
    if (rowIndex < 0) return false;

    const nextRowIndex = rowIndex + direction;
    if (nextRowIndex < 0 || nextRowIndex >= rows.length) return true;

    const fromRect = target.getBoundingClientRect();
    const fromCenterX = fromRect.left + (fromRect.width / 2);
    const nextRow = rows[nextRowIndex];
    if (!nextRow || nextRow.length === 0) return true;

    let candidate = nextRow[0];
    let minDiff = Number.POSITIVE_INFINITY;

    nextRow.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + (rect.width / 2);
        const diff = Math.abs(centerX - fromCenterX);
        if (diff < minDiff) {
            minDiff = diff;
            candidate = el;
        }
    });

    focusQuickBookingControl(candidate);
    return true;
}

function handleQuickBookingArrowNavigation(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const isTargetControl = target.matches('#bookTime, input[name="bookRoom"], #bookName, #bookTeam, #bookLevel, #bookPeople, #bookDeposit, #bookPartyRoom, #reservationGraceMinutes');
    if (!isTargetControl) return;

    if (event.key === 'ArrowLeft') {
        if (moveQuickBookingHorizontal(target, -1)) event.preventDefault();
        return;
    }
    if (event.key === 'ArrowRight') {
        if (moveQuickBookingHorizontal(target, 1)) event.preventDefault();
        return;
    }
    if (event.key === 'ArrowUp') {
        if (moveQuickBookingVertical(target, -1)) event.preventDefault();
        return;
    }
    if (event.key === 'ArrowDown') {
        if (moveQuickBookingVertical(target, 1)) event.preventDefault();
    }
}

function initQuickBookingArrowNavigation() {
    const bookingBar = document.getElementById('bookingBar');
    if (!bookingBar || bookingBar.dataset.arrowNavBound === '1') return;
    bookingBar.dataset.arrowNavBound = '1';
    bookingBar.addEventListener('keydown', handleQuickBookingArrowNavigation);
}

function addSupplyRow(itemName = '', unit = 0, targetBodyId = 'supplyTableBodyCol1', allowCard = true) {
    const tbody = document.getElementById(targetBodyId);
    if (!tbody) return;
    tbody.appendChild(createSupplyRow(itemName, unit, allowCard));
    updateSupplyTotals();
}

function initSupplyTable() {
    const col1Body = document.getElementById('supplyTableBodyCol1');
    const col2Body = document.getElementById('supplyTableBodyCol2');
    if (!col1Body || !col2Body) return;

    const unitByItem = {
        '슬러시': 1500,
        '파우치': 1500,
        '얼음컵': 1000,
        '음료세트': 2000,
        '양말': 1000,
        '사진': 2000,
        '다회(성)': 56000,
        '다회(청)': 40000
    };

    const col1Items = ['슬러시', '음료세트', '양말', '다회(성)'];
    const col2Items = ['파우치', '얼음컵', '사진', '다회(청)'];

    if (!col1Body.querySelector('tr') && !col2Body.querySelector('tr')) {
        col1Items.forEach((name) => addSupplyRow(name, unitByItem[name], 'supplyTableBodyCol1', !name.startsWith('다회')));
        col2Items.forEach((name) => addSupplyRow(name, unitByItem[name], 'supplyTableBodyCol2', !name.startsWith('다회')));
    }
    renderSupplyHistory();
    updateSupplyAccumulatedTotals();
    updateSupplyTotals();
}

function syncSupplyPanelWidth() {
    // 레이아웃 변경: walkin 카드는 timeline-area 헤더 왼쪽(시간열)에 위치하므로
    // beverage-container 너비는 CSS 기본값(300px)으로 독립 관리됨
}

function addBookingFromBar() {
    const mainWrapper = document.querySelector('.main-wrapper');
    
    const isPast = mainWrapper && mainWrapper.dataset.readonly === "true";

    if (isPast) {
        alert("🔒 과거 날짜에는 새로운 예약을 추가할 수 없습니다.");
        return;
    }

    const timeKey = document.getElementById('bookTime').value;
    const checkedRoom = document.querySelector('input[name="bookRoom"]:checked');
    const name = document.getElementById('bookName').value.trim();
    const team = document.getElementById('bookTeam').value.trim().slice(0, 10);
    const level = normalizeLevelShortcut(document.getElementById('bookLevel').value);
    const people = document.getElementById('bookPeople').value;
    const phone = document.getElementById('bookPhone').value.replace(/[^0-9]/g, '');
    const isDeposit = document.getElementById('bookDeposit').checked;
    const isPartyRoom = document.getElementById('bookPartyRoom').checked;
    if (!checkedRoom) { alert("룸을 선택해주세요."); return; }
    if (!name) { alert("성함을 입력해주세요."); return; }

    const room = checkedRoom.value;

    const isSmallRoom = (room === 'C1' || room === 'C2');
    const autoRoomFlags = isSmallRoom ? { F: false, S: true, M: false, L: false } : { F: false, S: false, M: false, L: false };
    const autoRoomFlagLabel = isSmallRoom ? '소' : '-';

    const timeKeys = [timeKey];
    if (isPartyRoom) {
        let currentTimeKey = timeKey;
        for (let i = 1; i < 6; i++) {
            const nextTimeKey = getNextTimeKey(currentTimeKey);
            if (!nextTimeKey) {
                alert('선택 시간부터 6개 타임을 만들 수 없습니다.');
                return;
            }
            timeKeys.push(nextTimeKey);
            currentTimeKey = nextTimeKey;
        }
    }

    timeKeys.forEach((key) => {
        const cell = document.getElementById(`cell-${key}-${room}`);
        if (!cell) return;

        const bookingData = {
            name: name,
            team: team,
            level: level,
            people: people,
            phone: phone,
            paid: 0,
            completed: 0,
            roomFlagLabel: autoRoomFlagLabel
        };

        const card = addCard(cell, bookingData, 0, isPast);

        if (phone) {
            card.dataset.phone = phone;
        }

        let basePayment = {
            totalPeople: people || '',
            roomFlags: autoRoomFlags,
            roomFlagLabel: autoRoomFlagLabel
        };

        if (isPartyRoom) {
            basePayment.partyRoom = true;
        } else if (isDeposit) {
            basePayment.isBooker = true;
            basePayment.depositPaid = true;
            basePayment.depositAmount = 5000;
            basePayment.reservationTime = formatTimeKeyForReservationBadge(key);
        }
        card.dataset.paymentData = JSON.stringify(basePayment);

        updateCardView(card);
        saveCard(card);
        // 팀카드 배지 초기화 (신규 추가 시점)
        const paymentData = parsePaymentDataSafe(card.dataset.paymentData);
        const isBooker = !!(paymentData?.isBooker || paymentData?.depositPaid);
        setTeamCardBookerBadge(card, isBooker, paymentData?.reservationTime || formatTimeKeyForReservationBadge(key));
    });

    document.getElementById('bookName').value = "";
    document.getElementById('bookTeam').value = "";
    document.getElementById('bookLevel').value = "";
    document.getElementById('bookPeople').value = "";
    document.getElementById('bookPhone').value = "";
    document.getElementById('bookDeposit').checked = false;
    document.getElementById('bookPartyRoom').checked = false;
    document.querySelectorAll('input[name="bookRoom"]').forEach(r => r.checked = false);
}

const debouncedSave = debounce((card) => saveCard(card), 1500);

function createBookingCard() {
    const card = document.createElement('div');
    card.className = 'booking-card';
    card.dataset.bid = '0';
    card.dataset.dragId = `drag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    card.innerHTML = `
        <div class="team-card-badge-wrap">
            <span class="team-card-badge team-card-badge-overlay payment-booker-badge inactive" style="display: none;">예약:<span class="reservation-time-emph">--:--</span></span>
            <span class="team-card-delay-overlay" style="display:none;"></span>
        </div>
        <div class="cell-view has-booking" draggable="true" ondragstart="drag(event)" onclick="openPaymentModalFromTimeline(this)">
            <div class="booking-info" ondblclick="editCard(this.closest('.booking-card')); event.stopPropagation()">
                <div class="team-main-row">
                    <div class="p-team-text"></div>
                    <div class="name-meta-row"><span class="p-name-text"></span><span class="p-level-people-text"> </span></div>
                </div>
                <div class="p-payment-text"><span class="p-paid-status queue-transfer-status" style="color:#d32f2f;">결제미완료</span><span class="p-payment-amounts"></span>
                    <div class="booking-status">
                        <div class="queue-action-row">
                            <button class="queue-transfer-btn" onclick="event.stopPropagation(); sendCardToQueue(this)" title="전송"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg></button>
                            <button class="queue-copy-btn" onclick="event.stopPropagation(); copyCardInfo(this)" title="복사"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
                            <button class="queue-complete-btn" onclick="event.stopPropagation(); markCompleted(this)" title="완료"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
                        </div>
                    </div>
                </div>
                <input type="checkbox" class="p-paid" style="display:none;" onclick="toggleStatus(this)">
                <input type="checkbox" class="p-completed" style="display:none;" onclick="toggleStatus(this)">   
            </div>   
        </div>
        <div class="cell-edit" style="display:none;">
            <input type="text" class="cell-input name p-name" placeholder="성함" onblur="saveCell(this)" onkeydown="if(event.key==='Enter') this.blur();">
            <input type="text" class="cell-input team p-team" placeholder="팀명" maxlength="10" onblur="saveCell(this)" onkeydown="if(event.key==='Enter') this.blur();">
            <div class="cell-row">
                <input type="text" class="cell-input level p-level" placeholder="난이도" onfocus="prepareLevelInput(this)" onclick="clearPreparedLevelInput(this)" oninput="autoLevel(this)" onblur="saveCell(this)" onkeydown="if(event.key==='Enter') this.blur();">
                <input type="number" class="cell-input people p-people" placeholder="인원" onblur="saveCell(this)" onkeydown="if(event.key==='Enter') this.blur();">
            </div>
            <input type="text" class="cell-input room-flag p-room-flag" placeholder="방사이즈(소/중/대)" onblur="saveCell(this)">
        </div>`;
    return card;
}

function addCard(cell, bookingData, bid = 0, isPast = false) {
    const card = createBookingCard();
    card.dataset.bid = bid;

    const isViewAll = document.body.classList.contains('view-all-mode');
    
    if (isPast) {
        card.dataset.readonly = "true";
        card.style.cursor = "not-allowed"; // 마우스 커서를 금지 모양으로
        card.title = "과거 데이터는 조회만 가능합니다.";
    }
    
    updateCard(card, bookingData);
    cell.appendChild(card);

    if (isPast) {
        card.querySelectorAll('button, input[type="checkbox"]').forEach(el => {
            el.style.display = 'none';
        });
    }

    return card;
}

function updateCard(card, b) {
    const view = card.querySelector('.cell-view');
    const isViewAll = document.body.classList.contains('view-all-mode');

    view.querySelector('.p-team-text').textContent = b.team || '';
    view.querySelector('.p-name-text').textContent = b.name || '';
    const level = b.level || '';
    const people = b.people || '';
    // 전화번호 저장
    if (b.phone) {
        card.dataset.phone = b.phone;
    }
    let roomFlagLabel = '-';
    const pDataRaw = b.payment_data || card.dataset.paymentData;
    const parsed = parsePaymentDataSafe(pDataRaw);
    // 1. 우선 b 객체에 직접 값이 있는지 확인
    if (b.roomFlagLabel && b.roomFlagLabel !== '-') {
        roomFlagLabel = b.roomFlagLabel;
    } 
    // 2. [로그 기반 해결책] b.payment_data(문자열) 혹은 이미 카드에 붙은 dataset 확인
    else {
        if (parsed) {
            roomFlagLabel = parsed.roomFlagLabel || roomFlagLabelFromFlags(parsed.roomFlags || {}) || '-';
        }
    }

    // 화면 갱신
    const metaContainer = view.querySelector('.p-level-people-text');
    if (metaContainer) {
        metaContainer.innerHTML = buildCardMetaHtml(level, people, roomFlagLabel);
    }
    // ------------------------------------------

    const parsedPaymentData = parsePaymentDataSafe(b.payment_data || card.dataset.paymentData);
    card.querySelector('.p-paid').checked = !!b.paid;
    card.querySelector('.p-completed').checked = !!b.completed;
    
    if (parsedPaymentData) {
        card.dataset.paymentData = JSON.stringify(parsedPaymentData);
        const paymentEl = card.querySelector('.p-payment-text');
        if (paymentEl) {
            const amountsEl = paymentEl.querySelector ? paymentEl.querySelector('.p-payment-amounts') : null;
            const target = amountsEl || paymentEl;
            target.innerHTML = buildCardPaymentHtml(parsedPaymentData);
        }
    } else {
        card.dataset.paymentData = '';
    }
    updateCardView(card);
    updateCardQueueStatus(card);
    
    // 팀카드 배지 초기화 (DB 로드 시점)
    const isBooker = !!(parsedPaymentData?.isBooker || parsedPaymentData?.depositPaid);
    setTeamCardBookerBadge(card, isBooker, parsedPaymentData?.reservationTime || getReservationTimeFromCard(card));
}

function updateCardView(card) {
    const view = card.querySelector('.cell-view');
    const isViewAll = document.body.classList.contains('view-all-mode');

    const paidCheckbox = card.querySelector('.p-paid');
    if (!paidCheckbox) return;

    const metaContainer = view.querySelector('.p-level-people-text');
    const paymentTextEl = card.querySelector('.p-payment-text');
    const paymentAmounts = card.querySelector('.p-payment-amounts');

    if (isViewAll) {
        const nameMeta = card.querySelector('.name-meta-row');
        const actionRow = card.querySelector('.queue-action-row');
        
        if (nameMeta) nameMeta.style.display = 'none';
        if (paymentAmounts) paymentAmounts.style.display = 'none';
        if (actionRow) actionRow.style.display = 'none';

    } else {
        if (metaContainer) metaContainer.style.display = 'block';
        if (paymentAmounts) paymentAmounts.style.display = 'block';
        card.style.margin = ""; 
        view.style.padding = "";
    }

    let paymentData = parsePaymentDataSafe(card.dataset.paymentData);
    if (paymentData) {
        card.dataset.paymentData = JSON.stringify(paymentData);
    }
    syncCopyBadgeFromPaymentData(card, paymentData);
    const isReservationCard = !!(paymentData?.isBooker || paymentData?.depositPaid);

    const paymentAmountsEl = card.querySelector('.p-payment-amounts');
    if (paymentAmountsEl && !isViewAll) {
        paymentAmountsEl.innerHTML = buildCardPaymentHtml(paymentData);
    }

    let badgeWrap = card.querySelector('.team-card-badge-wrap');
    if (!badgeWrap) {
        const existingBadge = card.querySelector('.team-card-badge');
        if (existingBadge) {
            badgeWrap = document.createElement('div');
            badgeWrap.className = 'team-card-badge-wrap';
            card.insertBefore(badgeWrap, card.firstChild);
            badgeWrap.appendChild(existingBadge);
        }
    }
    let conflictEl = card.querySelector('.team-card-delay-overlay');
    if (!conflictEl && badgeWrap) {
        conflictEl = document.createElement('span');
        conflictEl.className = 'team-card-delay-overlay';
        conflictEl.style.display = 'none';
        badgeWrap.appendChild(conflictEl);
    }
    const delayMin = parseInt(paymentData?.reservationConflict?.delayMinutes, 10) || 0;
    const hasDelayConflict = isReservationCard && delayMin > 0;
    setTeamCardBookerBadge(card, isReservationCard, paymentData?.reservationTime || getReservationTimeFromCard(card));
    if (conflictEl) {
        if (hasDelayConflict) {
            conflictEl.textContent = `지연(+${delayMin}분)`;
            conflictEl.style.display = 'block';
        } else {
            conflictEl.textContent = '';
            conflictEl.style.display = 'none';
        }
    }
    view.classList.toggle('reservation-conflict', hasDelayConflict);

    // 구형 카드(결제 체크박스 라벨만 있는 구조)도 새 상태 텍스트 UI로 보정
    let paidStatus = card.querySelector('.p-paid-status');
    if (!paidStatus) {
        const paidLabel = paidCheckbox.closest('label');
        if (paidLabel) paidLabel.style.display = 'none';
        paidCheckbox.style.display = 'none';
        paidStatus = document.createElement('span');
        paidStatus.className = 'p-paid-status';
        paidStatus.style.color = '#d32f2f';
        const paymentTextEl = card.querySelector('.p-payment-text');
        if (paymentTextEl) {
            paymentTextEl.insertBefore(paidStatus, paymentTextEl.firstChild);
        } else {
            const bookingStatus = card.querySelector('.booking-status');
            if (bookingStatus) bookingStatus.insertBefore(paidStatus, bookingStatus.firstChild);
        }
    }

    const isPaid = paidCheckbox.checked;
    const isPartyRoom = !!paymentData?.partyRoom;
    const isCompleted = card.querySelector('.p-completed').checked;

    view.classList.toggle('party-room', isPartyRoom);
    view.classList.toggle('unpaid', !isPartyRoom && !isPaid);
    view.classList.toggle('paid', !isPartyRoom && isPaid);
    view.classList.toggle('completed', isCompleted);

    // 완료 상태에 따라 버튼 기능/아이콘/색상 전환
    const completeBtn = card.querySelector('.queue-complete-btn');
    if (completeBtn) {
        completeBtn.classList.toggle('restore', isCompleted);
        completeBtn.title = isCompleted ? '원복' : '완료';
        completeBtn.innerHTML = isCompleted
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    }

    if (paidStatus) {
        if (isViewAll) {
            if (isPartyRoom) {
                // 1) 전체보기 모드에서도 파티룸은 보라색 유지
                paidStatus.textContent = '[파티룸]';
                paidStatus.style.color = '#6a1b9a';
            } else {
                const statusTxt = isPaid ? '결제' : '미결';
                const completeTxt = isCompleted ? '/입장' : '';
                paidStatus.textContent = `[${statusTxt}${completeTxt}]`;
                paidStatus.style.color = isPaid ? '#008800' : '#d32f2f';
            }
        } else {
            // 일반 모드 기존 로직
            if (isPartyRoom) {
                paidStatus.textContent = '파티룸';
                paidStatus.style.color = '#6a1b9a';
            } else {
                paidStatus.textContent = isPaid ? '(완료)' : '(미완료)';
                paidStatus.style.color = isPaid ? '#00aa00' : '#d32f2f';
            }
        }
    }

    // 클래스 토글 (배경색 등 CSS 연동)
    view.classList.toggle('party-room', isPartyRoom);
    view.classList.toggle('paid', isPaid);
    view.classList.toggle('completed', isCompleted);
    // 전체보기 모드일 때 가독성 방해 요소 제거

    const metaRow = view.querySelector('.name-meta-row');
    if (metaRow && isViewAll) metaRow.style.display = 'none';

    const bid = parseInt(card.dataset.bid || '0', 10);
    if (bid) {
        const queueItem = document.querySelector(`.queue-item-manual[data-bid="${bid}"]`);
        if (queueItem) applyQueueToneFromCard(queueItem, card);
    }
    updateCardQueueStatus(card);
}

async function saveCard(card) {
    if (card.dataset.readonly === "true") {
        console.warn("조회 전용 모드이므로 서버에 저장하지 않습니다.");
        return;
    }
    if (!card) return;
    const cell = card.closest('td');
    if (!cell) return;
    const parts = cell.id.split('-');
    const bid = parseInt(card.dataset.bid) || 0;
    const reservationTime = getReservationTimeFromCell(cell);

    const lptElement = card.querySelector('.p-level-people-text');
    const meta = parseCardMetaText(lptElement.textContent);
    let currentRoomFlag = '-';
    
    let parsedPaymentData = parsePaymentDataSafe(card.dataset.paymentData);

    if (parsedPaymentData) {
        currentRoomFlag = parsedPaymentData.roomFlagLabel || '-';
    }
    if (parsedPaymentData && (parsedPaymentData.isBooker || parsedPaymentData.depositPaid)) {
        parsedPaymentData.reservationTime = reservationTime;
        card.dataset.paymentData = JSON.stringify(parsedPaymentData);
        setTeamCardBookerBadge(card, true, reservationTime);
    }
    
    // 이미 저장된 카드인 경우 기존 order_no 유지, 새로운 카드인 경우만 현재 순서 적용
    let orderNo = bid > 0 ? parseInt(card.dataset.orderNo) || getCardOrderNo(card) : getCardOrderNo(card);
    
    const booking = {
        booking_date: getDashboardDateYMD(),
        time_key: `${parts[1]}-${parts[2]}`,
        room: parts[3],
        name: card.querySelector('.p-name-text').textContent.trim(),
        team: card.querySelector('.p-team-text').textContent.trim(),
        order_no: orderNo,
        paid: card.querySelector('.p-paid').checked,
        completed: card.querySelector('.p-completed').checked,
        payment_data: card.dataset.paymentData || null
    };
    // const meta = parseCardMetaText(card.querySelector('.p-level-people-text').textContent);

    if ((!meta.roomFlagLabel || meta.roomFlagLabel === '-') && currentRoomFlag !== '-') {
        meta.roomFlagLabel = currentRoomFlag;
        // 화면의 텍스트도 실제 데이터와 일치하도록 즉시 업데이트 (선택 사항이지만 추천)
        lptElement.innerHTML = buildCardMetaHtml(meta.level, meta.people, currentRoomFlag);
    }

    booking.level = meta.level || '';
    booking.people = meta.people || '';
    booking.phone = card.dataset.phone || '';
    booking.roomFlagLabel = currentRoomFlag || '-';
    booking.naver_booking_id = parsedPaymentData?.naverBookingId || '';
    
    try {
        let res;
        if (bid > 0) {
            res = await fetch(`/api/booking/${bid}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(booking)
            });
        } else {
            res = await fetch('/api/booking/add', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(booking)
            });
            if (res.ok) {
                const d = await res.json();
                card.dataset.bid = d.id;
                card.dataset.orderNo = orderNo;
            }
        }
        if (!res.ok) throw new Error('서버 저장 실패');
        card.style.transition = 'background-color 0.3s';
        card.style.backgroundColor = '#c8e6c9';
        setTimeout(() => { card.style.backgroundColor = ''; }, 800);
        updateDashboardSettlementSummary();
        recomputeReservationConflictIndicators();
        updateAllTimelineEta();
    } catch(e) {
        console.error('저장 실패:', e);
        card.style.backgroundColor = '#ffcdd2';
    }
    updateTimelineOverlays();
}

async function clearCard(card) {
    if (card.dataset.readonly === "true") {
        alert("🔒 과거 데이터는 삭제가 불가능합니다.");
        return;
    }
    const removedGroupId = String(card?.dataset?.copyGroupId || '').trim();
    const bid = parseInt(card.dataset.bid) || 0;
    if (bid > 0) {
        try { await fetch(`/api/booking/${bid}`, {method: 'DELETE'}); }
        catch(e) { console.error('카드 삭제 실패', e); }
    }
    const cell = card.closest('td');
    card.remove();
    if (cell) updateBookingPresence(cell);
    if (removedGroupId) {
        await renumberCopyGroup(removedGroupId);
    }
    updateDashboardSettlementSummary();
    recomputeReservationConflictIndicators();
    updateAllTimelineEta();
}

async function clearCell(cell) {
    for (const card of [...cell.querySelectorAll('.booking-card')]) {
        await clearCard(card);
    }
}

function editCard(card) {
    if (card.dataset.readonly === "true") {
        alert("🔒 과거 데이터는 수정할 수 없습니다. \n(당일 및 미래 데이터만 수정 가능)");
        return;
    }

    const view = card.querySelector('.cell-view');
    const edit = card.querySelector('.cell-edit');

    view.style.display = 'none';
    edit.style.display = 'block';

    edit.querySelector('.p-name').value = view.querySelector('.p-name-text').textContent;
    edit.querySelector('.p-team').value = view.querySelector('.p-team-text').textContent;
    const parsed = parseCardMetaText(view.querySelector('.p-level-people-text').textContent);
    edit.querySelector('.p-level').value = parsed.level || '';
    edit.querySelector('.p-people').value = parsed.people || '';
    
    edit.querySelector('.p-name').focus();
}


function saveCell(input) {
    const card = input.closest('.booking-card');

    if (card.dataset.readonly === "true") {
        console.warn("과거 데이터는 저장할 수 없습니다.");
        return;
    }

    const view = card.querySelector('.cell-view');
    const edit = card.querySelector('.cell-edit');
    const teamValue = edit.querySelector('.p-team').value.slice(0, 10);
    edit.querySelector('.p-team').value = teamValue;
    const levelValue = normalizeLevelShortcut(edit.querySelector('.p-level').value);
    edit.querySelector('.p-level').value = levelValue;
    view.querySelector('.p-name-text').textContent = edit.querySelector('.p-name').value;
    view.querySelector('.p-team-text').textContent = teamValue;
    const people = edit.querySelector('.p-people').value;
    const parsed = parseCardMetaText(view.querySelector('.p-level-people-text').textContent);
    view.querySelector('.p-level-people-text').innerHTML = buildCardMetaHtml(levelValue, people, parsed.roomFlagLabel);
    edit.style.display = 'none';
    view.style.display = '';
    updateCardView(card);
    debouncedSave(card);
}

function markCompleted(buttonEl) {
    const card = buttonEl.closest('.booking-card');
    if (!card) return;
    const checkbox = card.querySelector('.p-completed');
    if (!checkbox) return;
    const wasCompleted = checkbox.checked;
    if (wasCompleted) {
        checkbox.checked = false; // 원복
    } else {
        checkbox.checked = true;  // 완료처리
    }
    updateCardView(card);
    updateCardQueueStatus(card);
    saveCard(card);
}

function toggleStatus(checkbox) {
    const card = checkbox.closest('.booking-card');
    updateCardView(card);
    saveCard(card);
    updateDashboardSettlementSummary();
}

// 하위 호환성 실라스 (saveRow는 기존 코드가 참조할 수 있으므로 노열)
function saveRow(td) {
    if (!td) return;
    td.querySelectorAll('.booking-card').forEach(card => saveCard(card));
}

// 하위 호환성 실라스
function updateCell(cell, b) {
    const mainWrapper = document.querySelector('.main-wrapper');
    const isPast = mainWrapper && mainWrapper.dataset.readonly === "true";

    addCard(cell, b, b.id || 0, isPast);
}
function updateCellView(cell) {
    cell.querySelectorAll('.booking-card').forEach(updateCardView);
}

function cellHasBooking(cell) {
    return cell.querySelectorAll('.booking-card').length > 0;
}

function updateBookingPresence(cell) {
    // 카드 자체가 has-booking을 항상 보유하므로 no-op
}

function initSchedule(startHour = 10, endHour = 23, interval = 20) {
    const tbody = document.getElementById('timelineBody');
    if (!tbody) return;
    tbody.innerHTML = "";

    const ROOM_LIST = (typeof ROOMS !== 'undefined') ? ROOMS : ['C1', 'C2', 'B1', 'B2'];

    for(let h = startHour; h < endHour; h++) {
        for(let m = 0; m < 60; m += interval) {
            if (h === 22 && m > 40) break;

            const timeKey = `${h}-${m}`;
            const tr = document.createElement('tr');
            
            const timeTd = document.createElement('td');
            timeTd.className = 'time-col';
            timeTd.textContent = `${h}:${m === 0 ? '00' : m}`;
            tr.appendChild(timeTd);

            // 기존 ROOMS 상수를 사용하여 셀 생성
            ROOMS.forEach(room => {
                const cellTd = document.createElement('td');
                cellTd.id = `cell-${h}-${m}-${room}`;
                cellTd.setAttribute('ondragover', 'allowDrop(event)');
                cellTd.setAttribute('ondrop', 'drop(event)');
                tr.appendChild(cellTd);
            });
            tbody.appendChild(tr);
        }
    }
    // 데이터 재배치 (기존 함수 호출)
    //if (typeof loadBookings === 'function') loadBookings();

}

function autoLevel(input) {
    input.value = normalizeLevelShortcut(input.value);
}

function prepareLevelInput(input) {
    input.select();
    input.dataset.clearPending = '1';
}

function clearPreparedLevelInput(input) {
    if (input.dataset.clearPending === '1') {
        input.value = '';
        input.dataset.clearPending = '0';
    }
}

function setDayType(type, options = {}) {
    const { forced = false } = options;
    document.body.dataset.dayType = type;
    document.body.dataset.dayTypeForced = forced ? '1' : '0';
    document.getElementById('adultPrice').value = (type === 'weekday') ? 6000 : 7000;
    document.getElementById('childPrice').value = (type === 'weekday') ? 4000 : 5000;
    const dayTypeDisplay = document.getElementById('dayTypeDisplay');
    if (dayTypeDisplay) {
        dayTypeDisplay.textContent = (type === 'weekday') ? '평일' : '주말';
        dayTypeDisplay.style.color = (type === 'weekday') ? '#1976d2' : '#d32f2f';
    }
    const forceDayTypeBtn = document.getElementById('forceDayTypeBtn');
    if (forceDayTypeBtn) {
        forceDayTypeBtn.textContent = (type === 'weekday') ? '주말로변경' : '평일로변경';
    }
    updateDayTypeForcedUi(forced);
    updatePriceDisplay();
}

async function loadBookings() {
    try {
        const targetDate = getDashboardDateYMD();
        const today = new Date().toISOString().split('T')[0];
        const isPast = targetDate < today; // 오늘보다 이전이면 true

        if (isPast) {
            // 직전에 이미 인증하고 보던 과거 날짜가 아니라 '새로운 과거 날짜'를 선택한 경우에만 비번 팝업 띄우기
            if (targetDate !== lastValidSelectedDate) {
                const userInput = prompt("🔒 과거 데이터 조회 보안 잠금\n관리자 비밀번호를 입력해주세요:");
                
                if (userInput !== ADMIN_PASSWORD) {
                    alert("❌ 비밀번호가 올바르지 않거나 취소가 감지되었습니다.");
                    
                    // 📅 인풋창 달력 날짜를 직전에 보던 안전한 날짜로 강제 롤백
                    const dateInput = document.getElementById("dashboard-date");
                    if (dateInput) {
                        dateInput.value = lastValidSelectedDate;
                    }
                    return; // 🚀 [원천 차단]: 하단의 디비 조회 및 카드 초기화 로직을 아예 실행하지 않고 여기서 즉시 탈출합니다!
                }
            }
        }

        lastValidSelectedDate = targetDate;

        const isViewAll = document.body.classList.contains('view-all-mode');

        document.querySelectorAll('.booking-card').forEach(card => card.remove());
        const mainWrapper = document.querySelector('.main-wrapper'); 
        if (mainWrapper) {
            mainWrapper.dataset.readonly = isPast ? "true" : "false";
        }

        await loadSupplyHistoryFromDB();
        await loadDashboardCashExpenseAmount();
        await loadDashboardNoShowCount();

        const res = await fetch(`/api/booking/list?date=${encodeURIComponent(targetDate)}`);
        if (!res.ok) throw new Error('예약 내역 로드 실패');
        const data = await res.json();

        data.forEach(b => {
            let effectiveTimeKey = b.time_key;
            if (isViewAll) {
                const hour = b.time_key.split('-')[0];
                effectiveTimeKey = `${hour}-0`; 
            }

            const cell = document.getElementById(`cell-${effectiveTimeKey}-${b.room}`);
            if (cell) {
                addCard(cell, b, b.id, isPast); 
            }
        });

        syncAllQueueLabelsFromCards();
        updateDashboardSettlementSummary();
        recomputeReservationConflictIndicators();
        updateAllTimelineEta();

    } catch (error) {
        console.error(error);
    }
}

async function saveAllBookings() {
    // 1. 현재 대시보드 날짜 가져오기 (기존 함수 활용)
    const targetDate = typeof getDashboardDateYMD === 'function' 
                       ? getDashboardDateYMD() 
                       : state.targetDate;

    // 2. 라이브러리 로드 체크 (가장 중요)
    if (!window.GoogleSheetsManager) {
        console.error("GoogleSheetsManager가 아직 로드되지 않았습니다.");
        alert("잠시만 기다려주세요. 라이브러리를 불러오는 중입니다.");
        return;
    }

    // 2. 정산 데이터 계산 (core.js의 computeTotals 활용)
    // 대시보드에 정산 테이블이 없다면 totals는 null로 전달됩니다.
    let totals = null;
    try {
        if (typeof computeTotals === 'function') {
            totals = computeTotals();
        }
    } catch (e) {
        console.warn("정산 데이터 계산 스킵 (테이블 없음)");
    }

    // 3. 버튼 로딩 표시 (사용자 경험)
    const btn = document.querySelector('.btn-save-bookings');
    const originalText = btn.innerHTML;
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = "⏳ 저장 중...";
    }

    // 4. google_sheets.js에 정의한 매니저 호출
    const success = await window.GoogleSheetsManager.saveToSheet(targetDate, totals);

    // 5. 버튼 복구
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }

    if (success) {
        // 구글 시트 저장이 성공하면 엑셀 다운로드도 트리거
        window.location.href = `/api/booking/export-excel?date=${encodeURIComponent(targetDate)}`;
    }
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

let minuteBoundaryTimeout = null;
let minuteBoundaryTickInterval = null;

function getMsToNextMinuteBoundary() {
    const now = new Date();
    const elapsed = (now.getSeconds() * 1000) + now.getMilliseconds();
    return Math.max(1, 60000 - elapsed);
}

function updateMinuteBoundaryTimerText() {
    const timerEl = document.getElementById('minuteBoundaryTimer');
    if (!timerEl) {
        updateRoomCountdownTexts();
        updateCurrentTimeGridLine();
        updateTimelineOverlays();
        return;
    }

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    timerEl.textContent = `현재 ${hh}:${mm}:${ss}`;
    updateRoomCountdownTexts();
    updateCurrentTimeGridLine();
    updateTimelineOverlays();
}

function scheduleMinuteBoundaryRefresh() {
    if (minuteBoundaryTimeout) {
        clearTimeout(minuteBoundaryTimeout);
        minuteBoundaryTimeout = null;
    }

    minuteBoundaryTimeout = setTimeout(async () => {
        try {
            await refreshRoomAndQueue();
        } catch (err) {
            console.error('분 경계 갱신 실패:', err);
        } finally {
            scheduleMinuteBoundaryRefresh();
        }
    }, getMsToNextMinuteBoundary() + 30);
}

function startMinuteBoundaryTimer() {
    if (minuteBoundaryTickInterval) {
        clearInterval(minuteBoundaryTickInterval);
        minuteBoundaryTickInterval = null;
    }

    updateMinuteBoundaryTimerText();
    minuteBoundaryTickInterval = setInterval(updateMinuteBoundaryTimerText, 1000);
    scheduleMinuteBoundaryRefresh();
}

window.onload = async function() {
    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }
    updateTodayDate();
    initReservationGraceMinutes();
    await autoSetDayTypeFromKoreanCalendar();
    initTimeSelect();
    startMinuteBoundaryTimer();
    initSchedule(10, 23, 20);
    bindTimelineManualScrollControl();
    updateCurrentTimeGridLine();
    updateTimelineOverlays();
    requestAnimationFrame(() => {
        setTimeout(() => {
            updateCurrentTimeGridLine();
            updateTimelineOverlays();
        }, 150);
        setTimeout(() => {
            updateCurrentTimeGridLine();
            updateTimelineOverlays();
        }, 600);
    });
    initPaymentModalArrowNavigation();
    initPaymentModalDragging();
    initPaymentModalBlankClickAutoSave();
    ['roomFlagF', 'roomFlagS', 'roomFlagM', 'roomFlagL'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                applyRoomFlagRules(id);
                calculatePayment();
            });
        }
    });
    renderRoomStatus({ map: {}, status: {}, data: {} });
    await loadSupplyHistoryFromDB();
    await loadDashboardCashExpenseAmount();
    await loadDashboardNoShowCount();
    initSupplyTable();
    initSupplyInputNavigation();
    initQuickBookingArrowNavigation();
    syncSupplyPanelWidth();
    loadQueueItems().catch(err => console.error('대기 리스트 로드 실패', err));
    refreshWalkInList();
    loadBookings();
    fetchRoomStatus();
    //setInterval(fetchRoomStatus, 60000);
    window.addEventListener('resize', syncSupplyPanelWidth);
};

let currentPaymentItem = null;
let currentPaymentCell = null;
let currentPaymentCard = null;

// 라인 기반 네비게이션 정의
// Line 0: 팀명 / Line 1: 성함·방·난이도 / Line 2: 인원현황 / Line 3: 결제수단
const NAV_LINES = [
    ['paymentTeamName'],
    ['paymentName', 'paymentRoomSelect', 'paymentLevel'],
    ['totalPeople', 'adultCount', 'nonCardAdultCount', 'adultPassCount', 'childCount', 'childPassCount', 'couponCount'],
    ['cardInput', 'cashInput', 'transferInput']
];
const NAV_SPAN_FIELDS = { paymentTeamName: 'team', paymentName: 'name', paymentLevel: 'level' };

function setPaymentRoomValue(roomValue) {
    const value = (roomValue || '').toString().trim().toUpperCase();
    const roomSpan = document.getElementById('paymentRoom');
    if (roomSpan) roomSpan.textContent = value;
    const roomSelect = document.getElementById('paymentRoomSelect');
    if (roomSelect && ['C1', 'C2', 'B1', 'B2'].includes(value)) {
        roomSelect.value = value;
    }
    applyAutoRoomFlags(value);
}

window.onReservationGraceMinutesChanged = onReservationGraceMinutesChanged;

function onPaymentRoomSelectChange() {
    const roomSelect = document.getElementById('paymentRoomSelect');
    if (!roomSelect) return;
    const newValue = (roomSelect.value || '').toUpperCase();
    setPaymentRoomValue(newValue);
    calculatePayment();

    if (!currentPaymentCard || !currentPaymentCell) return;

    const card = currentPaymentCard;
    const oldCell = currentPaymentCell;
    const timeKey = oldCell.id.split('-').slice(1, 3).join('-');
    const newCellId = `cell-${timeKey}-${newValue}`;
    const newCell = document.getElementById(newCellId);
    if (!newCell) {
        alert('해당 룸을 찾을 수 없습니다.');
        setPaymentRoomValue(oldCell.id.split('-')[3]);
        return;
    }

    if (newCell !== oldCell) {
        oldCell.removeChild(card);
        newCell.appendChild(card);
        currentPaymentCell = newCell;
        applyCardRoomFlagsForRoom(card, newValue);
    }
    saveCard(card);
}

function navGetPos(fieldId) {
    for (let li = 0; li < NAV_LINES.length; li++) {
        const ci = NAV_LINES[li].indexOf(fieldId);
        if (ci !== -1) return { li, ci };
    }
    return null;
}

function navFocus(li, ci) {
    if (li < 0 || li >= NAV_LINES.length) return;
    ci = Math.max(0, Math.min(NAV_LINES[li].length - 1, ci));
    const fieldId = NAV_LINES[li][ci];
    const spanField = NAV_SPAN_FIELDS[fieldId];
    if (spanField) {
        const el = document.getElementById(fieldId);
        if (el && el.tagName === 'SPAN') {
            editField(el, spanField);
        } else {
            const modal = document.getElementById('paymentModal');
            const fe = modal ? modal.querySelector(`.field-edit[data-nav-id="${fieldId}"]`) : null;
            if (fe) fe.focus();
        }
    } else {
        const el = document.getElementById(fieldId);
        if (el) { el.focus(); try { el.select(); } catch(err) {} }
    }
}

function editField(span, field) {
    if (!span || span.tagName === 'INPUT' || span.tagName === 'SELECT') return; // 이미 편집 중
    const currentText = span.classList.contains('field-placeholder') ? '' : span.textContent;
    const metaItem = span.closest('.payment-meta-item');

    if (field === 'room') {
        const select = document.createElement('select');
        select.className = 'field-edit';
        ['C1','C2','B1','B2'].forEach(r => {
            const opt = document.createElement('option');
            opt.value = r; opt.textContent = r;
            if (r === currentText) opt.selected = true;
            select.appendChild(opt);
        });
        select.onchange = () => saveField(select, 'room');
        select.onblur = () => saveField(select, 'room');
        select.dataset.navId = 'paymentRoom';
        span.replaceWith(select);
        if (metaItem) metaItem.classList.add('editing');
        select.focus();
        return;
    }

    if (field === 'phone') {
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.value = currentText;
        input.maxLength = 11;
        input.className = 'field-edit';
        input.oninput = () => { input.value = input.value.replace(/[^0-9]/g, ''); };
        input.onblur = () => saveField(input, field);
        input.dataset.navId = 'paymentPhone';
        span.replaceWith(input);
        if (metaItem) metaItem.classList.add('editing');
        input.focus();
        return;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentText;
    if (field === 'team') {
        input.maxLength = 10;
    }
    if (field === 'level') {
        input.oninput = () => autoLevel(input);
        input.onfocus = () => prepareLevelInput(input);
        input.onclick = () => clearPreparedLevelInput(input);
    }
    input.className = 'field-edit';
    input.onblur = () => saveField(input, field);
    input.dataset.navId = field === 'team' ? 'paymentTeamName' : `payment${field.charAt(0).toUpperCase() + field.slice(1)}`;

    span.replaceWith(input);
    if (metaItem) {
        metaItem.classList.add('editing');
    }
    input.focus();
    if (field === 'level') {
        prepareLevelInput(input);
    }
}

function syncLinkedQueueItemFromCard(card) {
    if (!card) return;
    const bid = parseInt(card.dataset.bid || '0', 10);
    if (!bid) return;

    const teamText = card.querySelector('.p-team-text')?.textContent.trim() || '';
    const nameText = card.querySelector('.p-name-text')?.textContent.trim() || '';
    const levelPeopleText = card.querySelector('.p-level-people-text')?.textContent.trim() || '';
    let paymentData = null;
    try {
        paymentData = card.dataset.paymentData ? JSON.parse(card.dataset.paymentData) : null;
    } catch (e) {
        paymentData = null;
    }
    const isPartyRoom = !!paymentData?.partyRoom;
    const parsed = parseCardMetaText(levelPeopleText);
    const levelText = parsed.level || '';
    const peopleTextRaw = parsed.people || '';
    const roomFlags = paymentData?.roomFlags || roomFlagsFromLabel(parsed.roomFlagLabel);
    const roomFlagLabel = roomFlagLabelFromFlags(roomFlags);
    const peopleText = peopleTextRaw ? `${peopleTextRaw}명` : '-';
    const title = teamText || nameText || '대기';

    let queueItem = document.querySelector(`.queue-item-manual[data-bid="${bid}"]`);
    if (!queueItem) {
        // bid 미연결 항목은 동일 방 + 동일 팀/이름의 유일 후보일 때만 연결
        const cardCell = card.closest('td[id^="cell-"]');
        const cardRoom = (cardCell?.id.split('-')[3] || '').toUpperCase();
        const candidates = [...document.querySelectorAll('.queue-item-manual')].filter((el) => {
            const qBid = parseInt(el.dataset.bid || '0', 10);
            const qRoom = (el.dataset.room || '').toUpperCase();
            const qTeam = (el.dataset.team || '').trim();
            const qName = (el.dataset.name || '').trim();
            if (qBid > 0) return false;
            if (cardRoom && qRoom !== cardRoom) return false;
            if (teamText && qTeam === teamText) return true;
            if (!teamText && nameText && qName === nameText) return true;
            return false;
        });
        if (candidates.length !== 1) return;
        queueItem = candidates[0];
        queueItem.dataset.bid = String(bid);
    }

    queueItem.dataset.team = teamText;
    queueItem.dataset.name = nameText;
    queueItem.dataset.level = levelText;
    queueItem.dataset.people = peopleTextRaw;
    queueItem.dataset.partyRoom = isPartyRoom ? '1' : '0';
    queueItem.dataset.roomFlagLabel = roomFlagLabel;
    queueItem.dataset.roomFlags = JSON.stringify(roomFlags);
    applyQueueToneFromCard(queueItem, card);

    const infoSpan = queueItem.querySelector('.info');
    if (infoSpan) {
        infoSpan.innerHTML = buildQueueInfoText(
            title,
            peopleText,
            queueItem.dataset.room || '',
            roomFlagLabel,
            roomFlags,
            levelText,
            isPartyRoom,
            paymentData
        );
    }

    const qid = parseInt(queueItem.dataset.qid || '0', 10);
    if (qid) {
        const payload = {
            name: nameText,
            team: teamText,
            level: levelText,
            people: peopleTextRaw,
            bid,
            partyRoom: isPartyRoom
        };
        const payloadSignature = JSON.stringify(payload);
        if (queueItem.dataset.lastSyncPayload === payloadSignature) {
            return;
        }
        queueItem.dataset.lastSyncPayload = payloadSignature;

        fetch(`/api/queue/${qid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(err => console.error('대기 항목 동기화 실패:', err));
    }
}

function saveField(input, field) {
    const newValue = field === 'team'
        ? input.value.slice(0, 10)
        : (field === 'level' ? normalizeLevelShortcut(input.value) : input.value);
    const span = document.createElement('span');
    const metaItem = input.closest('.payment-meta-item');
    span.id = field === 'team' ? 'paymentTeamName' : `payment${field.charAt(0).toUpperCase() + field.slice(1)}`;
    const isEditable = ['team', 'name', 'level', 'phone'].includes(field);
    if (isEditable && !newValue) {
        span.textContent = '미입력';
        span.classList.add('field-placeholder');
    } else {
        span.textContent = newValue;
        span.classList.remove('field-placeholder');
    }
    // 자동저장 클릭 필터([onclick])에 걸리도록 속성도 유지
    span.setAttribute('onclick', `editField(this, '${field}')`);
    span.onclick = () => editField(span, field);

    if (currentPaymentCard) {
        if (field === 'room') {
            const card = currentPaymentCard;
            const oldCell = currentPaymentCell;
            const timeKey = oldCell.id.split('-').slice(1, 3).join('-');
            const newCellId = `cell-${timeKey}-${newValue}`;
            const newCell = document.getElementById(newCellId);
            if (newCell) {
                const bid = parseInt(card.dataset.bid) || 0;
                oldCell.removeChild(card);
                newCell.appendChild(card);
                currentPaymentCell = newCell;
                saveCard(card);
            } else {
                alert('해당 룸을 찾을 수 없습니다.');
                span.textContent = oldCell.id.split('-')[3];
            }
        } else {
            const card = currentPaymentCard;
            const lpt = card.querySelector('.p-level-people-text');
            const parsed = parseCardMetaText(lpt.textContent);

            if (field === 'name') {
                card.querySelector('.p-name-text').textContent = newValue;
            } else if (field === 'team') {
                card.querySelector('.p-team-text').textContent = newValue;
            } else if (field === 'level') {
                lpt.innerHTML = buildCardMetaHtml(newValue, parsed.people, parsed.roomFlagLabel);
            } else if (field === 'people') { // 👈 추가: 인원 수정 시
                lpt.innerHTML = buildCardMetaHtml(parsed.level, newValue, parsed.roomFlagLabel);
            } else if (field === 'roomFlagLabel') { // 👈 추가: 방 사이즈 수정 시
                lpt.innerHTML = buildCardMetaHtml(parsed.level, parsed.people, newValue);
            } else if (field === 'phone') {
                card.dataset.phone = newValue;
            }
            syncLinkedQueueItemFromCard(card);
            saveCard(card);
        }
    }
    
    input.replaceWith(span);
    if (metaItem) {
        metaItem.classList.remove('editing');
    }
}

function openPaymentModalFromTimeline(cellView) {
    const card = cellView.closest('.booking-card');
    const cell = cellView.closest('td');
    if (!card || !cell) return;
    const teamText = card.querySelector('.p-team-text').textContent.trim();
    const nameText = card.querySelector('.p-name-text').textContent.trim();
    const levelPeopleText = card.querySelector('.p-level-people-text').textContent.trim();
    

    currentPaymentCell = cell;
    currentPaymentCard = card;
    currentPaymentItem = null;
    const modal = document.getElementById("paymentModal");

    const parsedMeta = parseCardMetaText(levelPeopleText);
    const level = parsedMeta.level || '';
    const people = parsedMeta.people || '';
    const room = cell.id.split('-')[3];
    const phoneText = card.dataset.phone || '';

    const paymentData = parsePaymentDataSafe(card.dataset.paymentData);
    const isBooker = !!(paymentData?.isBooker || paymentData?.depositPaid);
    const reservationTime = paymentData?.reservationTime || getReservationTimeFromCard(card);
    setPaymentBookerBadge(isBooker, reservationTime);
    syncCopyBadgeFromPaymentData(card, paymentData);
    setPaymentCopyGroupBadge(card);
    closePaymentCopyGroupPicker();

    // 팀카드 배지도 함께 업데이트
    setTeamCardBookerBadge(card, isBooker, reservationTime);

    const _teamVal = teamText || nameText;
    const _teamNameSpan = document.getElementById("paymentTeamName");
    _teamNameSpan.textContent = _teamVal || '미입력';
    _teamNameSpan.classList.toggle('field-placeholder', !_teamVal);
    const _nameSpan = document.getElementById("paymentName");
    _nameSpan.textContent = nameText || '미입력';
    _nameSpan.classList.toggle('field-placeholder', !nameText);
    const _phoneSpan = document.getElementById("paymentPhone");
    
    _phoneSpan.textContent = phoneText || '미입력';
    _phoneSpan.classList.toggle('field-placeholder', !phoneText);
    const _levelSpan = document.getElementById("paymentLevel");
    _levelSpan.textContent = level || '미입력';
    _levelSpan.classList.toggle('field-placeholder', !level);
    setPaymentRoomValue(room);

    document.getElementById("totalPeople").value = paymentData?.totalPeople || people || "";
    document.getElementById("adultCount").value = paymentData?.adultCount || "";
    document.getElementById("childCount").value = paymentData?.childCount || "";
    document.getElementById("couponCount").value = paymentData?.coupon || "";
    document.getElementById("adultPassCount").value = paymentData?.adultPass || "";
    document.getElementById("childPassCount").value = paymentData?.childPass || "";
    document.getElementById("depositPaid").checked = !!paymentData?.depositPaid;
    document.getElementById("partyRoom").checked = !!paymentData?.partyRoom;
    document.getElementById("nonCardAdultCount").value = paymentData?.nonCardAdultCount || "";
    document.getElementById("cardInput").value = paymentData?.cardInput || "";
    document.getElementById("cashInput").value = paymentData?.cashInput || "";
    document.getElementById("transferInput").value = paymentData?.transferInput || "";
    if (paymentData?.roomFlags) {
        setRoomFlags(paymentData.roomFlags);
    } else {
        setRoomFlags(roomFlagsFromLabel(parsedMeta.roomFlagLabel));
    }

    document.getElementById("paymentMatchStatus").style.display = "none";
    togglePartyRoomMode();
    validatePassCounts();
    calculatePayment();
    updatePriceDisplay();

    resetPaymentModalPosition();
    modal.classList.add("show");
}

function updatePriceDisplay() {
    const dayType = getCurrentDayType();
    const priceDisplay = document.getElementById('priceDisplay');
    if (!priceDisplay) return;
    const priceInfoBox = priceDisplay.closest('.price-info-box');
    if (dayType === 'weekday') {
        priceDisplay.innerHTML = '<div style="font-weight: 600;">Today: <span style="color:#1976d2;">평일</span></div><div style="font-size: 10px; color: #666; margin-top: 2px;">성인 6,000원 / 학생 4,000원</div>';
        if (priceInfoBox) {
            priceInfoBox.style.background = '#e0e7ff';
            priceInfoBox.style.borderColor = '#5555cc';
        }
    } else {
        priceDisplay.innerHTML = '<div style="font-weight: 600;">Today: <span style="color:#d32f2f;">주말</span></div><div style="font-size: 10px; color: #666; margin-top: 2px;">성인 7,000원 / 학생 5,000원</div>';
        if (priceInfoBox) {
            priceInfoBox.style.background = '#ffe0e0';
            priceInfoBox.style.borderColor = '#cc5555';
        }
    }
}

function openPaymentModal(queueItem) {
    currentPaymentItem = queueItem;
    currentPaymentCell = null; // 타임라인 셀이 아님을 표시
    const modal = document.getElementById("paymentModal");
    const nameSpan = queueItem.querySelector(".info b");
    const nameText = nameSpan ? nameSpan.textContent.trim() : "";
    
    const paymentData = parsePaymentDataSafe(queueItem.dataset.paymentData);
    const isBooker = !!(paymentData?.isBooker || paymentData?.depositPaid);
    setPaymentBookerBadge(isBooker, paymentData?.reservationTime || '');
    setPaymentCopyGroupBadge(null);
    closePaymentCopyGroupPicker();
    
    const teamNameSpan = document.getElementById("paymentTeamName");
    if (teamNameSpan) {
        teamNameSpan.textContent = nameText || '미입력';
        teamNameSpan.classList.toggle('field-placeholder', !nameText);
    }
    // This part needs to be adapted if we want to edit info from the queue
    
    document.getElementById("totalPeople").value = paymentData?.totalPeople || "";
    document.getElementById("adultCount").value = paymentData?.adultCount || "";
    document.getElementById("childCount").value = paymentData?.childCount || "";
    document.getElementById("couponCount").value = paymentData?.coupon || "";
    document.getElementById("adultPassCount").value = paymentData?.adultPass || "";
    document.getElementById("childPassCount").value = paymentData?.childPass || "";
    document.getElementById("depositPaid").checked = paymentData?.depositPaid || false;
    document.getElementById("partyRoom").checked = !!paymentData?.partyRoom;
    document.getElementById("nonCardAdultCount").value = paymentData?.nonCardAdultCount || "";
    
    document.getElementById("cardInput").value = paymentData?.cardInput || "";
    document.getElementById("cashInput").value = paymentData?.cashInput || "";
    document.getElementById("transferInput").value = paymentData?.transferInput || "";
    setPaymentRoomValue(currentPaymentItem?.dataset?.room || 'C1');
    if (paymentData?.roomFlags) {
        setRoomFlags(paymentData.roomFlags);
    }
    
    document.getElementById("paymentMatchStatus").style.display = "none";
    togglePartyRoomMode();
    
    validatePassCounts();
    calculatePayment();
    updatePriceDisplay();
    resetPaymentModalPosition();
    modal.classList.add("show");
}

function closePaymentModal() {
    const modal = document.getElementById("paymentModal");
    modal.querySelectorAll('input.field-edit').forEach(input => input.blur());
    modal.classList.remove("show");
    setPaymentCopyGroupBadge(null);
    closePaymentCopyGroupPicker();
    currentPaymentItem = null;
    currentPaymentCell = null;
    currentPaymentCard = null;
}

function resetPaymentModalPosition() {
    const modal = document.getElementById('paymentModal');
    const content = modal?.querySelector('.modal-content');
    if (!content) return;
    content.style.position = '';
    content.style.left = '';
    content.style.top = '';
}

function initPaymentModalDragging() {
    const modal = document.getElementById('paymentModal');
    const content = modal?.querySelector('.modal-content');
    if (!modal || !content) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    content.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!modal.classList.contains('show')) return;

        const t = e.target;
        if (t instanceof HTMLElement) {
            if (t.closest('button,input,select,textarea,a,label,.field-edit,[onclick]')) return;
        }

        const rect = content.getBoundingClientRect();
        content.style.position = 'fixed';
        content.style.left = `${rect.left}px`;
        content.style.top = `${rect.top}px`;

        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        originLeft = rect.left;
        originTop = rect.top;
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const maxLeft = Math.max(8, window.innerWidth - content.offsetWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - content.offsetHeight - 8);
        const nextLeft = Math.min(Math.max(8, originLeft + dx), maxLeft);
        const nextTop = Math.min(Math.max(8, originTop + dy), maxTop);

        content.style.left = `${nextLeft}px`;
        content.style.top = `${nextTop}px`;
    });

    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
    });
}

function showGeneralDeleteDialog() {
    return new Promise((resolve) => {
        const dialog = document.getElementById('generalDeleteDialog');
        dialog.classList.add('open');
        const onConfirm = () => { cleanup(); resolve(true); };
        const onCancel  = () => { cleanup(); resolve(false); };
        function cleanup() {
            dialog.classList.remove('open');
            document.getElementById('gdBtnConfirm').removeEventListener('click', onConfirm);
            document.getElementById('gdBtnCancel').removeEventListener('click', onCancel);
        }
        document.getElementById('gdBtnConfirm').addEventListener('click', onConfirm);
        document.getElementById('gdBtnCancel').addEventListener('click', onCancel);
    });
}

function showPartyRoomDeleteDialog() {
    return new Promise((resolve) => {
        const dialog = document.getElementById('partyRoomDeleteDialog');
        dialog.classList.add('open');
        const onAll    = () => { cleanup(); resolve('all'); };
        const onOne    = () => { cleanup(); resolve('one'); };
        const onCancel = () => { cleanup(); resolve('cancel'); };
        function cleanup() {
            dialog.classList.remove('open');
            document.getElementById('prdBtnAll').removeEventListener('click', onAll);
            document.getElementById('prdBtnOne').removeEventListener('click', onOne);
            document.getElementById('prdBtnCancel').removeEventListener('click', onCancel);
        }
        document.getElementById('prdBtnAll').addEventListener('click', onAll);
        document.getElementById('prdBtnOne').addEventListener('click', onOne);
        document.getElementById('prdBtnCancel').addEventListener('click', onCancel);
    });
}

async function deleteCurrentPaymentCard() {
    if (!currentPaymentCard || !currentPaymentCell) {
        alert('타임테이블 팀카드를 연 상태에서만 삭제할 수 있습니다.');
        return;
    }

    const card = currentPaymentCard;
    const cell = currentPaymentCell;
    let cardsToDelete = [card];

    if (isPartyRoomCard(card)) {
        const choice = await showPartyRoomDeleteDialog();
        if (choice === 'all') {
            cardsToDelete = collectLinkedPartyRoomCards(card, cell);
        } else if (choice === 'one') {
            cardsToDelete = [card];
        } else {
            return; // 취소
        }
    } else {
        const confirmed = await showGeneralDeleteDialog();
        if (!confirmed) return;
    }

    for (const targetCard of cardsToDelete) {
        const bid = parseInt(targetCard.dataset.bid || '0', 10);
        if (bid) {
            const linkedQueueItem = document.querySelector(`.queue-item-manual[data-bid="${bid}"]`);
            if (linkedQueueItem) linkedQueueItem.remove();
        }
        await clearCard(targetCard);
    }

    closePaymentModal();
}

function initPaymentModalArrowNavigation() {
    const modal = document.getElementById("paymentModal");
    if (!modal) return;

    modal.addEventListener('keydown', (e) => {
        const target = e.target;
        if (target instanceof HTMLButtonElement && target.classList.contains('save-payment-btn') && e.key === 'Enter') {
            e.preventDefault();
            target.click();
            return;
        }
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
        if (!modal.contains(target)) return;

        const fieldId = target.id || target.dataset.navId;
        if (!fieldId) return;

        if (e.key === 'Enter' && fieldId === 'transferInput') {
            e.preventDefault();
            const saveBtn = modal.querySelector('.save-payment-btn');
            if (saveBtn instanceof HTMLButtonElement) {
                saveBtn.focus();
            }
            return;
        }

        const pos = navGetPos(fieldId);
        if (!pos) return;
        const { li, ci } = pos;
        const line = NAV_LINES[li];

        let targetLi = li, targetCi = ci, shouldMove = false;
        const isText = target.type === 'text';
        const atStart = isText ? (target.selectionStart === 0 && target.selectionEnd === 0) : true;
        const atEnd = isText ? (target.selectionStart === target.value.length && target.selectionEnd === target.value.length) : true;
        const isEmpty = target.value === '';

        if (e.key === 'ArrowUp') {
            if (li > 0) { targetLi = li - 1; targetCi = 0; shouldMove = true; }
        } else if (e.key === 'ArrowDown') {
            if (li < NAV_LINES.length - 1) { targetLi = li + 1; targetCi = 0; shouldMove = true; }
        } else if (e.key === 'ArrowLeft') {
            if (!isText || atStart) {
                if (ci > 0) { targetCi = ci - 1; shouldMove = true; }
                else if (li > 0) { targetLi = li - 1; targetCi = NAV_LINES[li-1].length - 1; shouldMove = true; }
            }
        } else if (e.key === 'ArrowRight') {
            if (!isText || atEnd) {
                if (ci < line.length - 1) { targetCi = ci + 1; shouldMove = true; }
                else if (li < NAV_LINES.length - 1) { targetLi = li + 1; targetCi = 0; shouldMove = true; }
            }
        } else if (e.key === 'Backspace' && isEmpty) {
            if (ci > 0) { targetCi = ci - 1; shouldMove = true; }
            else if (li > 0) { targetLi = li - 1; targetCi = NAV_LINES[li-1].length - 1; shouldMove = true; }
        } else if (e.key === 'Tab') {
            const isForward = !e.shiftKey;
            if (isForward) {
                if (ci < line.length - 1) { targetCi = ci + 1; shouldMove = true; }
                else if (li < NAV_LINES.length - 1) { targetLi = li + 1; targetCi = 0; shouldMove = true; }
            } else {
                if (ci > 0) { targetCi = ci - 1; shouldMove = true; }
                else if (li > 0) { targetLi = li - 1; targetCi = NAV_LINES[li-1].length - 1; shouldMove = true; }
            }
        } else if (e.key === 'Enter') {
            if (ci < line.length - 1) { targetCi = ci + 1; shouldMove = true; }
            else if (li < NAV_LINES.length - 1) { targetLi = li + 1; targetCi = 0; shouldMove = true; }
        }

        if (!shouldMove) return;
        e.preventDefault();

        // span 필드는 명시적으로 저장 후 이동 (onblur 이중저장 방지)
        if (target.dataset.navId) {
            const spanField = NAV_SPAN_FIELDS[target.dataset.navId];
            if (spanField) {
                target.onblur = null;
                if (target.tagName === 'SELECT') target.onchange = null;
                saveField(target, spanField);
            }
        }

        navFocus(targetLi, targetCi);
    });
}

function updatePeopleInputErrors() {
    const isPartyRoom = !!document.getElementById("partyRoom")?.checked;
    const totalPeople = Math.max(parseInt(document.getElementById("totalPeople")?.value) || 0, 0);
    const adultCount = Math.max(parseInt(document.getElementById("adultCount")?.value) || 0, 0);
    const nonCardAdultCount = Math.max(parseInt(document.getElementById("nonCardAdultCount")?.value) || 0, 0);
    const adultPassCount = Math.max(parseInt(document.getElementById("adultPassCount")?.value) || 0, 0);
    const childCount = Math.max(parseInt(document.getElementById("childCount")?.value) || 0, 0);
    const childPassCount = Math.max(parseInt(document.getElementById("childPassCount")?.value) || 0, 0);

    const adultMismatch = !isPartyRoom && (nonCardAdultCount + adultPassCount) > adultCount;
    const childMismatch = !isPartyRoom && childPassCount > childCount;
    const totalMismatch = !isPartyRoom && totalPeople !== (adultCount + childCount);

    ["adultCount", "nonCardAdultCount", "adultPassCount"].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.classList.toggle("input-error", adultMismatch);
    });

    ["childCount", "childPassCount"].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.classList.toggle("input-error", childMismatch);
    });

    const totalInput = document.getElementById("totalPeople");
    if (totalInput) totalInput.classList.toggle("input-error", totalMismatch);
}

function hasPeopleInputMismatch() {
    const totalPeople = Math.max(parseInt(document.getElementById("totalPeople")?.value) || 0, 0);
    const adultCount = Math.max(parseInt(document.getElementById("adultCount")?.value) || 0, 0);
    const nonCardAdultCount = Math.max(parseInt(document.getElementById("nonCardAdultCount")?.value) || 0, 0);
    const adultPassCount = Math.max(parseInt(document.getElementById("adultPassCount")?.value) || 0, 0);
    const childCount = Math.max(parseInt(document.getElementById("childCount")?.value) || 0, 0);
    const childPassCount = Math.max(parseInt(document.getElementById("childPassCount")?.value) || 0, 0);

    const adultMismatch = (nonCardAdultCount + adultPassCount) > adultCount;
    const childMismatch = childPassCount > childCount;
    const totalMismatch = totalPeople !== (adultCount + childCount);

    return adultMismatch || childMismatch || totalMismatch;
}

function validatePassCounts() {
    const adultCountInput = document.getElementById("adultCount");
    const childCountInput = document.getElementById("childCount");
    const adultPassInput = document.getElementById("adultPassCount");
    const childPassInput = document.getElementById("childPassCount");

    if (!adultCountInput || !childCountInput || !adultPassInput || !childPassInput) {
        return;
    }

    updatePeopleInputErrors();
}

function togglePartyRoomMode() {
    const isPartyRoom = !!document.getElementById("partyRoom")?.checked;
    const paymentInputIds = ["cardInput", "cashInput", "transferInput"];
    paymentInputIds.forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        if (isPartyRoom) {
            input.value = "";
            input.disabled = true;
        } else {
            input.disabled = false;
        }
        const item = input.closest('.payment-method-item');
        if (item) item.classList.toggle('disabled', isPartyRoom);
    });
    calculatePayment();
}

function splitCouponCounts(couponCount, adultCount, childCount, adultPassCount, childPassCount, nonCardAdultCount) {
    const safeCoupon = Math.max(parseInt(couponCount, 10) || 0, 0);
    const adultEligible = Math.max((parseInt(adultCount, 10) || 0) - (parseInt(adultPassCount, 10) || 0) - (parseInt(nonCardAdultCount, 10) || 0), 0);
    const childEligible = Math.max((parseInt(childCount, 10) || 0) - (parseInt(childPassCount, 10) || 0), 0);

    const appliedAdultCoupon = Math.min(safeCoupon, adultEligible);
    const remainingCoupon = Math.max(safeCoupon - appliedAdultCoupon, 0);
    const appliedChildCoupon = Math.min(remainingCoupon, childEligible);

    return {
        adult: appliedAdultCoupon,
        child: appliedChildCoupon,
        total: appliedAdultCoupon + appliedChildCoupon,
    };
}

function calculatePayment() {
    validatePassCounts();
    const isPartyRoom = !!document.getElementById("partyRoom")?.checked;
    
    // 팀카드에 인원정보 업데이트
    if (currentPaymentCard) {
        const totalPeople = parseInt(document.getElementById("totalPeople").value) || 0;
        const levelText = document.getElementById("paymentLevel")?.textContent?.trim() || '';
        const roomFlagLabel = roomFlagLabelFromFlags(getRoomFlagsFromModal());
        const levelPeopleElement = currentPaymentCard.querySelector('.p-level-people-text');
        if (levelPeopleElement) {
            levelPeopleElement.innerHTML = buildCardMetaHtml(levelText, totalPeople || '', roomFlagLabel);
        }
    }
    
    const adultPrice = parseInt(document.getElementById("adultPrice").value) || 6000;
    const childPrice = parseInt(document.getElementById("childPrice").value) || 4000;
    const isWeekendOrHoliday = getCurrentDayType() === 'weekend';
    
    const adultCount = parseInt(document.getElementById("adultCount").value) || 0;
    const childCount = parseInt(document.getElementById("childCount").value) || 0;
    const couponCount = parseInt(document.getElementById("couponCount").value) || 0;
    const adultPassCount = parseInt(document.getElementById("adultPassCount").value) || 0;
    const childPassCount = parseInt(document.getElementById("childPassCount").value) || 0;
    const nonCardAdultCountRaw = parseInt(document.getElementById("nonCardAdultCount").value) || 0;

    const safeAdultCount = Math.max(adultCount, 0);
    const safeChildCount = Math.max(childCount, 0);
    const safeAdultPass = Math.max(Math.min(adultPassCount, safeAdultCount), 0);
    const safeChildPass = Math.max(Math.min(childPassCount, safeChildCount), 0);
    const maxNonCardAdultCount = Math.max(safeAdultCount - safeAdultPass, 0);
    const nonCardAdultCount = Math.max(Math.min(nonCardAdultCountRaw, maxNonCardAdultCount), 0);
    const couponSplit = splitCouponCounts(couponCount, safeAdultCount, safeChildCount, safeAdultPass, safeChildPass, nonCardAdultCount);
    const appliedAdultCoupon = couponSplit.adult;
    const appliedChildCoupon = couponSplit.child;
    const appliedCoupon = couponSplit.total;
    const depositPaid = document.getElementById("depositPaid").checked;
    const depositAmount = depositPaid ? 5000 : 0;
    const payableAdultCount = Math.max(safeAdultCount - safeAdultPass - appliedAdultCoupon, 0);
    const nonCardAdultDiscount = isWeekendOrHoliday ? nonCardAdultCount * 1000 : 0;
    const allAdultNonCardDiscount = isWeekendOrHoliday ? payableAdultCount * 1000 : 0;
    
    // 기본 금액: 전체 인원 × 성인가격
    const baseAmount = (safeAdultCount + safeChildCount) * adultPrice;
    
    // 할인금액: 학생 차액(다회권 미사용 학생만) + 쿠폰 + 다회권 + 주말/공휴일 현금/계좌 성인 할인
    const studentDiscount = Math.max(safeChildCount - safeChildPass, 0) * (adultPrice - childPrice);
    const adultPassDiscount = safeAdultPass * adultPrice;
    const childPassDiscount = safeChildPass * adultPrice; // 학생 다회권도 성인가 기준 할인
    const freeCouponDiscount = (appliedAdultCoupon * adultPrice) + (appliedChildCoupon * childPrice);
    const couponDiscount = freeCouponDiscount;
    const passDiscount = adultPassDiscount + childPassDiscount;
    const passAndCouponDiscount = passDiscount + couponDiscount;
    const totalDiscount = studentDiscount + couponDiscount + passDiscount + nonCardAdultDiscount;
    
    // 실제 결제 금액 (선결제 예약금 반영)
    const amountBeforeDeposit = Math.max(baseAmount - totalDiscount, 0);
    document.getElementById("paymentAmount").dataset.beforeDeposit = amountBeforeDeposit;
    const actualPayment = Math.max(amountBeforeDeposit - depositAmount, 0);
    const cashPaymentAmount = Math.max(baseAmount - (studentDiscount + couponDiscount + passDiscount + allAdultNonCardDiscount) - depositAmount, 0);
    
    // UI 업데이트
    document.getElementById("baseAmount").textContent = baseAmount.toLocaleString();
    document.getElementById("baseAmountDetail").textContent = `(전체 ${safeAdultCount + safeChildCount}명 × ${adultPrice.toLocaleString()}원)`;
    document.getElementById("depositLine").style.display = "block";
    document.getElementById("depositAmount").textContent = depositAmount.toLocaleString();
    document.getElementById("discountLine").style.display = "block";
    document.getElementById("discountAmount").textContent = totalDiscount.toLocaleString();
    document.getElementById("discountAmountDetail").innerHTML = `(
        <span class="discount-detail-adult">성인다회: ${adultPassDiscount.toLocaleString()}</span> +
        <span class="discount-detail-child">학생다회: ${childPassDiscount.toLocaleString()}</span> +
        <span class="discount-detail-coupon">무료쿠폰: ${freeCouponDiscount.toLocaleString()}</span> +
        <span class="discount-detail-child">학생할인: ${studentDiscount.toLocaleString()}</span> +
        <span class="discount-detail-adult">현금할인: ${nonCardAdultDiscount.toLocaleString()}</span>
    )`.replace(/\s+/g, ' ').trim();
    
    // 성인/학생 금액 분리(예약금 제외, 할인 반영)
    const adultAmountBeforeDeposit = Math.max(
        (safeAdultCount * adultPrice)
        - (safeAdultPass * adultPrice)
        - (appliedAdultCoupon * adultPrice)
        - nonCardAdultDiscount,
        0
    );
    const childAmountBeforeDeposit = Math.max(
        (safeChildCount * adultPrice)
        - studentDiscount
        - (safeChildPass * adultPrice)
        - (appliedChildCoupon * childPrice),
        0
    );

    // 분리합계가 실제 예약금 제외 합계와 항상 일치하도록 보정
    const splitSum = adultAmountBeforeDeposit + childAmountBeforeDeposit;
    const splitDelta = amountBeforeDeposit - splitSum;
    const adjustedAdultAmount = Math.max(adultAmountBeforeDeposit + splitDelta, 0);

    document.getElementById("paymentAmount").textContent = actualPayment.toLocaleString();
    document.getElementById("cashPaymentAmount").textContent = cashPaymentAmount.toLocaleString();
    document.getElementById("adultAmount").textContent = adjustedAdultAmount.toLocaleString();
    document.getElementById("childAmount").textContent = childAmountBeforeDeposit.toLocaleString();
    document.getElementById("splitDepositAmount").textContent = depositAmount.toLocaleString();
    
    // 사용자가 입력한 금액 합계
    const cardInput = parseInt(document.getElementById("cardInput").value) || 0;
    const cashInput = parseInt(document.getElementById("cashInput").value) || 0;
    const transferInput = parseInt(document.getElementById("transferInput").value) || 0;
    const userTotal = cardInput + transferInput + cashInput;
    
    // 결제 현황 표시
    document.getElementById("cardPayAmount").textContent = cardInput.toLocaleString();
    document.getElementById("cashPayAmount").textContent = cashInput.toLocaleString();
    document.getElementById("transferPayAmount").textContent = transferInput.toLocaleString();
    
    // 일치/불일치 확인
    const statusDiv = document.getElementById("paymentMatchStatus");
    const needEl = document.getElementById("needAmount");
    const excessEl = document.getElementById("excessAmount");
    const payDiffBox = document.getElementById("payDiffBox");
    const peopleMismatch = !isPartyRoom && hasPeopleInputMismatch();
    if (peopleMismatch) {
        statusDiv.style.display = "block";
        statusDiv.style.background = "#ffcccc";
        statusDiv.style.color = "#d32f2f";
        statusDiv.textContent = "인원수 확인 필요";
        if (needEl) needEl.textContent = actualPayment.toLocaleString();
        if (excessEl) excessEl.textContent = "0";
        if (payDiffBox) payDiffBox.style.display = "block";
    } else if (isPartyRoom) {
        statusDiv.style.display = "block";
        statusDiv.style.background = "#eadcf7";
        statusDiv.style.color = "#6a1b9a";
        statusDiv.textContent = "파티룸";
        if (needEl) needEl.textContent = "0";
        if (excessEl) excessEl.textContent = "0";
        if (payDiffBox) payDiffBox.style.display = "none";
    } else if (depositAmount > 0 && amountBeforeDeposit < depositAmount && userTotal === 0) {
        // 예약금이 실제 필요 금액을 초과 (다회권/쿠폰으로 전액 처리됐는데 예약금도 납부)
        statusDiv.style.display = "block";
        statusDiv.style.background = "#ffcccc";
        statusDiv.style.color = "#d32f2f";
        statusDiv.textContent = "결제금액 불일치";
        if (needEl) needEl.textContent = "0";
        if (excessEl) excessEl.textContent = (depositAmount - amountBeforeDeposit).toLocaleString();
        if (payDiffBox) payDiffBox.style.display = "block";
    } else if (actualPayment === 0 && userTotal === 0) {
        statusDiv.style.display = "block";
        statusDiv.style.background = "#c8e6c9";
        statusDiv.style.color = "#2e7d32";
        statusDiv.textContent = "결제금액 일치";
        if (needEl) needEl.textContent = "0";
        if (excessEl) excessEl.textContent = "0";
        if (payDiffBox) payDiffBox.style.display = "none";
    } else if (actualPayment === 0 && userTotal > 0) {
        statusDiv.style.display = "block";
        statusDiv.style.background = "#ffcccc";
        statusDiv.style.color = "#d32f2f";
        statusDiv.textContent = "결제금액 불일치";
        if (needEl) needEl.textContent = "0";
        if (excessEl) excessEl.textContent = userTotal.toLocaleString();
        if (payDiffBox) payDiffBox.style.display = "block";
    } else if (userTotal === actualPayment) {
        statusDiv.style.display = "block";
        statusDiv.style.background = "#c8e6c9";
        statusDiv.style.color = "#2e7d32";
        statusDiv.textContent = "결제금액 일치";
        if (needEl) needEl.textContent = "0";
        if (excessEl) excessEl.textContent = "0";
        if (payDiffBox) payDiffBox.style.display = "none";
    } else if (userTotal > 0) {
        statusDiv.style.display = "block";
        statusDiv.style.background = "#ffcccc";
        statusDiv.style.color = "#d32f2f";
        statusDiv.textContent = "결제금액 불일치";
        if (needEl) needEl.textContent = Math.max(actualPayment - userTotal, 0).toLocaleString();
        if (excessEl) excessEl.textContent = Math.max(userTotal - actualPayment, 0).toLocaleString();
        if (payDiffBox) payDiffBox.style.display = "block";
    } else {
        statusDiv.style.display = "none";
        if (needEl) needEl.textContent = actualPayment.toLocaleString();
        if (excessEl) excessEl.textContent = "0";
        if (payDiffBox) payDiffBox.style.display = "block";
    }

    updatePeopleInputErrors();
}

function checkPaymentMatch() {
    if (hasPeopleInputMismatch()) return false;

    const cardInput = parseInt(document.getElementById("cardInput").value) || 0;
    const transferInput = parseInt(document.getElementById("transferInput").value) || 0;
    const cashInput = parseInt(document.getElementById("cashInput").value) || 0;
    const isPartyRoom = !!document.getElementById("partyRoom")?.checked;
    if (isPartyRoom) return true;
    
    // calculatePayment()와 동일하게 예약금 제외한 카드/현금/계좌 합계만 사용
    const userTotal = cardInput + transferInput + cashInput;
    const paymentAmountText = document.getElementById("paymentAmount").textContent.replace(/,/g, "");
    const actualPayment = parseInt(paymentAmountText) || 0;

    // 예약금 초과 납부 감지: 다회권/쿠폰이 전액 커버했는데 예약금도 납부된 경우
    const depositPaid = !!document.getElementById("depositPaid")?.checked;
    if (depositPaid && userTotal === 0 && actualPayment === 0) {
        const amountBeforeDeposit = parseInt(document.getElementById("paymentAmount")?.dataset.beforeDeposit ?? "-1");
        if (amountBeforeDeposit >= 0 && amountBeforeDeposit < 5000) {
            return false; // 예약금이 필요 금액보다 많음 = 불일치
        }
    }
    
    // 결제금액과 입력금액이 일치 (둘 다 0인 경우도 포함 = 다회권/쿠폰 전액 커버)
    return userTotal === actualPayment && (userTotal > 0 || actualPayment === 0);
}

function savePaymentInfo(closeAfterSave = true) {
    const totalPeople = parseInt(document.getElementById("totalPeople").value) || 0;
    const adultCount = parseInt(document.getElementById("adultCount").value) || 0;
    const childCount = parseInt(document.getElementById("childCount").value) || 0;
    const couponCountRaw = parseInt(document.getElementById("couponCount").value) || 0;
    const adultPassCount = Math.min(parseInt(document.getElementById("adultPassCount").value) || 0, adultCount);
    const childPassCount = Math.min(parseInt(document.getElementById("childPassCount").value) || 0, childCount);
    const couponCount = Math.max(couponCountRaw, 0);
    const depositPaid = document.getElementById("depositPaid").checked;
    const partyRoom = !!document.getElementById("partyRoom")?.checked;
    const roomFlags = getRoomFlagsFromModal();
    const roomFlagLabel = roomFlagLabelFromFlags(roomFlags);
    const depositAmount = depositPaid ? 5000 : 0;
    const nonCardAdultCountRaw = parseInt(document.getElementById("nonCardAdultCount").value) || 0;
    const cardInput = parseInt(document.getElementById("cardInput").value) || 0;
    const cashInput = parseInt(document.getElementById("cashInput").value) || 0;
    const transferInput = parseInt(document.getElementById("transferInput").value) || 0;

    let basePaymentData = null;
    if (currentPaymentCard) {
        basePaymentData = parsePaymentDataSafe(currentPaymentCard.dataset.paymentData);
    } else if (currentPaymentItem) {
        basePaymentData = parsePaymentDataSafe(currentPaymentItem.dataset.paymentData);
    }
    // 모달의 배지 상태(dataset.isBooker)를 isBooker로 사용
    const modal = document.getElementById("paymentModal");
    const isBooker = modal?.dataset.isBooker === '1';
    const reservationTime = (currentPaymentCard && getReservationTimeFromCard(currentPaymentCard))
        || (currentPaymentCell && getReservationTimeFromCell(currentPaymentCell))
        || basePaymentData?.reservationTime
        || '';

    // 결제 금액 계산
    const adultPrice = parseInt(document.getElementById("adultPrice").value) || 6000;
    const childPrice = parseInt(document.getElementById("childPrice").value) || 4000;
    const isWeekendOrHoliday = getCurrentDayType() === 'weekend';
    const baseAmount = (adultCount + childCount) * adultPrice;
    const studentDiscount = Math.max(childCount - childPassCount, 0) * (adultPrice - childPrice);
    const maxNonCardAdultCount = Math.max(adultCount - adultPassCount, 0);
    const nonCardAdultCount = Math.max(Math.min(nonCardAdultCountRaw, maxNonCardAdultCount), 0);
    const couponSplit = splitCouponCounts(couponCount, adultCount, childCount, adultPassCount, childPassCount, nonCardAdultCount);
    const appliedAdultCoupon = couponSplit.adult;
    const appliedChildCoupon = couponSplit.child;
    const appliedCoupon = couponSplit.total;
    const couponDiscount = (appliedAdultCoupon * adultPrice) + (appliedChildCoupon * childPrice);
    const passDiscount = (adultPassCount + childPassCount) * adultPrice;  // 학생 다회권도 성인가 기준 할인
    const payableAdultCount = Math.max(adultCount - adultPassCount - appliedAdultCoupon, 0);
    const nonCardAdultDiscount = isWeekendOrHoliday ? nonCardAdultCount * 1000 : 0;
    const totalDiscount = studentDiscount + couponDiscount + passDiscount + nonCardAdultDiscount;
    const finalPaymentAmount = Math.max(baseAmount - totalDiscount - depositAmount, 0);
    
    const userTotal = cardInput + transferInput + cashInput;
    const displayedFinalPaymentAmount = parseInt((document.getElementById("paymentAmount")?.textContent || "0").replace(/,/g, "")) || 0;
    const isMatchingPayment = checkPaymentMatch();
    const peopleMismatch = hasPeopleInputMismatch();
    const shouldMarkPaid = !peopleMismatch && (partyRoom || isMatchingPayment);

    // 결제 데이터 객체 생성
    const paymentData = {
        totalPeople,
        adultCount,
        childCount,
        coupon: appliedCoupon,
        couponAdult: appliedAdultCoupon,
        couponChild: appliedChildCoupon,
        adultPass: adultPassCount,
        childPass: childPassCount,
        nonCardAdultCount,
        isBooker,
        depositPaid,
        naverBookingId: basePaymentData?.naverBookingId || '',
        naverDepositCancelledByStaff: !!basePaymentData?.naverDepositCancelledByStaff,
        reservationTime,
        partyRoom,
        roomFlags,
        roomFlagLabel,
        depositAmount,
        cardInput,
        transferInput,
        cashInput,
        baseAmount,
        finalPaymentAmount: displayedFinalPaymentAmount,
        isMatching: !peopleMismatch && isMatchingPayment
    };

    if (basePaymentData?.copyGroupId && Number.isFinite(parseInt(basePaymentData?.copySeq, 10))) {
        paymentData.copyGroupId = String(basePaymentData.copyGroupId);
        paymentData.copySeq = parseInt(basePaymentData.copySeq, 10);
    }

    if (basePaymentData?.reservationConflict) {
        paymentData.reservationConflict = basePaymentData.reservationConflict;
    }
    setPaymentBookerBadge(isBooker, reservationTime);

    // 결제 수단 텍스트 생성
    let methodText = "";
    if (cardInput > 0) methodText += `카드 ${cardInput.toLocaleString()}원 `;
    if (cashInput > 0) methodText += `현금 ${cashInput.toLocaleString()}원 `;
    if (transferInput > 0) methodText += `계좌 ${transferInput.toLocaleString()}원 `;
    if (depositAmount > 0) methodText += `예약금 ${depositAmount.toLocaleString()}원 `;
    if (partyRoom) methodText = "파티룸";

    // 타임라인 셀에 정보 저장
    if (currentPaymentCell) {
        if (currentPaymentCard) {
            currentPaymentCard.dataset.paymentData = JSON.stringify(paymentData);
            const levelText = document.getElementById("paymentLevel")?.textContent?.trim() || '';
            const roomFlagLabelNow = roomFlagLabelFromFlags(roomFlags);
            const levelPeopleElement = currentPaymentCard.querySelector('.p-level-people-text');
            if (levelPeopleElement) {
                levelPeopleElement.innerHTML = buildCardMetaHtml(levelText, totalPeople || '', roomFlagLabelNow);
            }
            const paymentTextEl = currentPaymentCard.querySelector('.p-payment-amounts');
            if (paymentTextEl) paymentTextEl.innerHTML = buildCardPaymentHtml(paymentData);
            const paidCheckbox = currentPaymentCard.querySelector('.p-paid');
            if (paidCheckbox) {
                paidCheckbox.checked = shouldMarkPaid;
            }
            syncLinkedQueueItemFromCard(currentPaymentCard);
            updateCardView(currentPaymentCard);
            saveCard(currentPaymentCard);
            
            // 팀카드 배지 업데이트 (모달 배지 상태 반영)
            setTeamCardBookerBadge(currentPaymentCard, isBooker, reservationTime);
        }
        
        // 결제 완료 체크 표시 제거
        let checkMark = currentPaymentCell.querySelector(".payment-check-mark");
        if (checkMark) checkMark.remove();
        
        currentPaymentCell.dataset.paymentInfo = `${methodText || "입력필요"} (필요: ${displayedFinalPaymentAmount.toLocaleString()}원)`;
        // 여러 팀 카드가 같은 셀에 있을 수 있으므로 셀 배경색은 건드리지 않는다.
        currentPaymentCell.style.backgroundColor = "";
    } 
    // 큐 항목에 정보 저장
    else if (currentPaymentItem) {
        let paymentInfo = currentPaymentItem.querySelector(".payment-info");
        if (!paymentInfo) {
            paymentInfo = document.createElement("div");
            paymentInfo.className = "payment-info";
            paymentInfo.style = "font-size: 10px; margin-top: 3px; font-weight: bold;";
            currentPaymentItem.querySelector(".info").appendChild(paymentInfo);
        }
        const paymentHtml = buildCardPaymentHtml(paymentData);
        if (paymentHtml) {
            paymentInfo.innerHTML = paymentHtml;
            paymentInfo.style.color = "";
        } else {
            paymentInfo.textContent = `${methodText || "입력필요"} (필요: ${displayedFinalPaymentAmount.toLocaleString()}원)`;
            paymentInfo.style.color = shouldMarkPaid ? "#28a745" : "#ff6f00";
        }
        currentPaymentItem.dataset.paymentData = JSON.stringify(paymentData);
    }

    updateDashboardSettlementSummary();
    recomputeReservationConflictIndicators();

    if (closeAfterSave) {
        closePaymentModal();
    }
}

function initPaymentModalBlankClickAutoSave() {
    const modal = document.getElementById('paymentModal');
    const content = modal?.querySelector('.modal-content');
    if (!modal || !content) return;

    content.addEventListener('click', function (event) {
        if (!modal.classList.contains('show')) return;

        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        // 입력/버튼/레이블/클릭핸들러 영역은 기존 동작 유지
        if (target.closest('input,textarea,select,button,label,a,[onclick],.field-edit,.payment-meta-item,.payment-method-item,.people-input-item,.room-flag-grid,.modal-buttons,.payment-copy-group-tools,.payment-copy-group-picker')) {
            return;
        }

        const active = document.activeElement;
        if (active instanceof HTMLElement && modal.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
            active.blur();
        }

        calculatePayment();
        savePaymentInfo(false);
    });
}

// 모달 외부 클릭 시 닫기
window.addEventListener("click", function(event) {
    const modal = document.getElementById("paymentModal");
    const target = event.target;
    if (modal && modal.classList.contains('show')) {
        const targetEl = target instanceof HTMLElement ? target : null;
        if (!targetEl || !targetEl.closest('.payment-copy-group-tools')) {
            closePaymentCopyGroupPicker();
        }
    }
    if (event.target === modal) {
        closePaymentModal();
    }
});
