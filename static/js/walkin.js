/**
 * 점핑배틀 수원영통점 워크인 대시보드 스크립트
 * 기능: 다국어 번역, 인원 카운터, 팀명 글자수 제한, 데이터 전송
 */

// [1] 다국어 데이터 사전
const translations = {
    ko: {
        tabs: ["팀명 | 인원수 | 방사이즈 선택", "난이도 선택", "방문자 정보 | 신청하기"],
        step1: "Step 1. 팀 정보",
        teamPlace: "팀명 (공백 포함 최대 10자)",
        step2: "Step 2. 인원 입력",
        ageInfo: "연나이 5세~19세 청소년 요금이 적용됩니다.",
        adult: "성인",
        youth: "청소년",
        step3: "Step 3. 방 사이즈 선택",
        noExtra: "방 사이즈에 따른 추가요금은 없습니다.",
        fastRoom: "⚡ 방 사이즈 상관없이 가장 빠른 방 입장",
        step4: "Step 4. 난이도 선택",
        low: "쉬움",
        high: "어려움",
        order: `<span style="color: var(--kids-color);">유아</span> → <span style="color: var(--basic-color);">베이직</span> → <span style="color: var(--summer-color);">여름</span> → <span style="color: var(--easy-color);">이지</span> → <span style="color: var(--space-color);">우주</span> → <span style="color: var(--normal-color);">노멀</span> → <span style="color: var(--santa-color);">산타</span> → <span style="color: var(--hard-color);">하드</span> → <span style="color: var(--challenger-color);">챌린저</span>`,
        regMap: "정규맵",
        themeMap: "테마맵",
        themeInfo: "테마맵은 난이도가 섞여있습니다. 평균적인 난이도로 안내합니다.",
        step5: "Step 5. 방문자 정보",
        namePlace: "성함",
        phonePlace: "전화번호",
        warningTitle: "⚠️ 안전 이용 수칙 (필독)",
        warning1: "• 소아·청소년 광과민성 발작 주의 (관련 증상 시 체험 금지)",
        warning2: "• 과격한 플레이 금지! 부주의로 인한 부상은 책임지지 않습니다.",
        warning3: "• 쓸림 주의: 바닥 단차로 인해 기어 다니거나 슬라이딩 시 맨살이 쓸릴 수 있습니다.",
        warning4: "★ 어린이는 보호자의 각별한 주의 부탁드립니다!",
        agree: "안전 수칙 확인 및 개인정보 수집 동의 (필수)",
        submit: "신청하기",
        roomWarning: "(대형방에서 발판이 2/3만 켜집니다!)",
        starHint: "별갯수 참고하시면 됩니다!",
        onePersonOnly: "한분만 입력해주시면 됩니다.",
        rooms: {
            small: { name: "소형", info: "2~4인" },
            medium: { name: "중형", info: "3~6인" },
            large: { name: "대형", info: "5인 이상" }
        },
        levels: {
            basic: "베이직", easy: "이지", normal: "노멀", hard: "하드", challenger: "챌린저",
            toddler: "유아맵", summer: "여름맵", space: "우주맵", santa: "산타맵"
        },
        tags: {
            first: "처음하시는 분",
            exp: "경험자",
            afterNormal: "노멀 클리어 후",
            afterHard: "하드 클리어 후"
        },
        alerts: {
            noTeam: "팀명을 입력해주세요.",
            noCount: "인원을 입력해주세요.",
            noName: "예약자 성함을 입력해주세요.",
            noAgree: "개인정보 수집 및 이용에 동의해주세요.",
            success: "신청이 성공적으로 완료되었습니다. 잠시만 기다려주세요!",
            error: "서버 연결에 실패했습니다. 관리자에게 문의해주세요."
        }
    },
    en: {
        tabs: ["Team | People | Room Size", "Difficulty", "Visitor Info | Submit"],
        step1: "Step 1. Team Info",
        teamPlace: "Team Name (Max 10 chars)",
        step2: "Step 2. Guests",
        ageInfo: "Youth rates: 5-19 yrs.",
        adult: "Adult",
        youth: "Youth",
        step3: "Step 3. Select Room Size",
        noExtra: "No extra charge for room size.",
        fastRoom: "⚡ Enter the fastest available room",
        step4: "Step 4. Select Difficulty",
        low: "Easy",
        high: "Hard",
        order: `<span style="color: var(--kids-color);">Toddler</span> → <span style="color: var(--basic-color);">Basic</span> → <span style="color: var(--summer-color);">Summer</span> → <span style="color: var(--easy-color);">Easy</span> → <span style="color: var(--space-color);">Space</span> → <span style="color: var(--normal-color);">Normal</span> → <span style="color: var(--santa-color);">Santa</span> → <span style="color: var(--hard-color);">Hard</span> → <span style="color: var(--challenger-color);">Challenger</span>`,
        regMap: "Regular Map",
        themeMap: "Theme Map",
        themeInfo: "Theme maps have mixed difficulties. Shown as average.",
        step5: "Step 5. Visitor Info",
        namePlace: "Name",
        phonePlace: "Phone Number",
        warningTitle: "⚠️ Safety Rules (Must Read)",
        warning1: "• Photosensitive Seizure Warning (Avoid if you have related symptoms)",
        warning2: "• No rough play! We are not liable for injuries due to negligence.",
        warning3: "• Beware of Scrapes: Floor gaps may cause skin scrapes. Do not crawl or slide.",
        warning4: "★ Parents, please provide extra supervision for your children!",
        agree: "I agree to the safety rules and privacy policy (Required)",
        submit: "Submit",
        roomWarning: "(Only 2/3 of the floor tiles will light up in large rooms!)",
        starHint: "Please refer to the number of stars!",
        onePersonOnly: "Only one person needs to enter their info.",
        rooms: {
            small: { name: "Small", info: "2-4 ppl" },
            medium: { name: "Medium", info: "3-6 ppl" },
            large: { name: "Large", info: "5+ ppl" }
        },
        levels: {
            basic: "Basic", easy: "Easy", normal: "Normal", hard: "Hard", challenger: "Challenger",
            toddler: "Toddler", summer: "Summer", space: "Space", santa: "Santa"
        },
        tags: {
            first: "Beginner",
            exp: "Experienced",
            afterNormal: "After Normal",
            afterHard: "After Hard"
        },
        alerts: {
            noTeam: "Please enter your team name.",
            noCount: "Please enter the number of people.",
            noName: "Please enter your name.",
            noAgree: "Please agree to the privacy policy.",
            success: "Application submitted successfully. Please wait a moment!",
            error: "Server connection failed. Please contact the manager."
        }
    },
    zh: {
        tabs: ["队伍名 | 人数 | 房间大小", "选择难度", "访客信息 | 提交申请"],
        step1: "Step 1. 团队信息",
        teamPlace: "团队名称 (最多10字)",
        step2: "Step 2. 输入人数",
        ageInfo: "5至19岁的青少年适用优惠价格。",
        adult: "成人",
        youth: "青少年",
        step3: "Step 3. 选择房间大小",
        noExtra: "房间大小无额外费用。",
        fastRoom: "⚡ 无论大小，进入最快的房间",
        step4: "Step 4. 选择难度",
        low: "简单",
        high: "困难",
        order: `<span style="color: var(--kids-color);">幼儿</span> → <span style="color: var(--basic-color);">基础</span> → <span style="color: var(--summer-color);">夏日</span> → <span style="color: var(--easy-color);">简单</span> → <span style="color: var(--space-color);">宇宙</span> → <span style="color: var(--normal-color);">普通</span> → <span style="color: var(--santa-color);">圣诞</span> → <span style="color: var(--hard-color);">困难</span> → <span style="color: var(--challenger-color);">挑战者</span>`,
        themeMap: "主题地图",
        themeInfo: "主题地图难度混杂，显示为平均值。",
        step5: "Step 5. 访客信息",
        namePlace: "姓名",
        phonePlace: "电话号码",
        warningTitle: "⚠️ 安全守则 (必读)",
        warning1: "• 儿童及青少年光敏性癫痫警告 (如有相关症状请勿体验)",
        warning2: "• 禁止粗暴玩耍！因疏忽导致的受伤概不负责。",
        warning3: "• 小心擦伤：地板高度差可能导致皮肤擦伤，请勿在地上爬行或滑行。",
        warning4: "★ 请家长务必密切看管好您的孩子！",
        agree: "确认安全守则及同意个人信息收集 (必填)",
        submit: "提交",
        roomWarning: "(在大房间中, 只有2/3的踏板会亮起!)",
        starHint: "请参考星星的数量!",
        onePersonOnly: "仅需填入一位负责人的信息.",
        rooms: {
            small: { name: "小号", info: "2-4人" },
            medium: { name: "中号", info: "3-6人" },
            large: { name: "大号", info: "5人以上" }
        },
        levels: {
            basic: "基础", easy: "初级", normal: "普通", hard: "困难", challenger: "挑战者",
            toddler: "幼儿", summer: "夏天", space: "宇宙", santa: "圣诞"
        },
        tags: {
            first: "初学者",
            exp: "有经验者",
            afterNormal: "通过普通级后",
            afterHard: "通过困难级后"
        },
        alerts: {
            noTeam: "请输入团队名称。",
            noCount: "请输入人数。",
            noName: "请输入预订人姓名。",
            noAgree: "请同意个人信息收集相关条款。",
            success: "申请已成功提交，请稍候！",
            error: "服务器连接失败，请联系管理员。"
        }
    },
    ja: {
        tabs: ["チーム名 | 人数 | ルームサイズ", "難易度選択", "訪問者情報 | 申し込む"],
        step1: "Step 1. チーム情報",
        teamPlace: "チーム名 (最大10文字)",
        step2: "Step 2. 人数入力",
        ageInfo: "5歳〜19歳は青少年料金が適用されます。",
        adult: "大人",
        youth: "青少年",
        step3: "Step 3. ルームサイズ選択",
        noExtra: "ルームサイズによる追加料金はありません。",
        fastRoom: "⚡ サイズに関係なく最短で入場",
        step4: "Step 4. 難易度選択",
        low: "かんたん",
        high: "むずかしい",
        order: `<span style="color: var(--kids-color);">幼児</span> → <span style="color: var(--basic-color);">ベーシック</span> → <span style="color: var(--summer-color);">夏</span> → <span style="color: var(--easy-color);">イージー</span> → <span style="color: var(--space-color);">宇宙</span> → <span style="color: var(--normal-color);">ノーマル</span> → <span style="color: var(--santa-color);">サンタ</span> → <span style="color: var(--hard-color);">ハード</span> → <span style="color: var(--challenger-color);">チャレンジャー</span>`,
        regMap: "レギュラーマップ",
        themeMap: "テーママップ",
        themeInfo: "テーママップは難易度が混在しています。平均で表示します。",
        step5: "Step 5. 訪問者情報",
        namePlace: "お名前",
        phonePlace: "電話番号",
        warningTitle: "⚠️ 安全利用ルール (必読)",
        warning1: "• 子供・青少年の光感受性発作にご注意ください (症状がある場合は体験禁止)",
        warning2: "• 過激なプレイ禁止！不注意による怪我は責任を負いかねます。",
        warning3: "• 擦り傷注意：床の段差により皮膚を擦りむく恐れがあります。這ったり滑ったりしないでください。",
        warning4: "★ お子様には保護者の方の細心の注意をお願いいたします！",
        agree: "安全規約の確認および個人情報の収集に同意 (必須)",
        submit: "申し込む",
        roomWarning: "(大部屋では足場が2/3のみ点灯します!)",
        starHint: "星の数を参考にしてください!",
        onePersonOnly: "代表者お一人様のみご入力ください.",
        rooms: {
            small: { name: "小型", info: "2-4名" },
            medium: { name: "中型", info: "3-6名" },
            large: { name: "大型", info: "5人以上" }
        },
        levels: {
            basic: "ベーシック", easy: "イージー", normal: "ノーマル", hard: "ハード", challenger: "チャレンジャー",
            toddler: "幼児マップ", summer: "夏マップ", space: "宇宙マップ", santa: "サンタマップ"
        },
        tags: {
            first: "初めての方",
            exp: "経験者",
            afterNormal: "ノーマルクリア後",
            afterHard: "ハードクリア後"
        },
        alerts: {
            noTeam: "チーム名を入力してください。",
            noCount: "人数を入力してください。",
            noName: "予約者のお名前を入力してください。",
            noAgree: "個人情報の収集にご同意ください。",
            success: "申し込みが完了しました。少々お待ちください！",
            error: "サーバーへの接続に失敗しました。管理者に問い合わせてください。"
        }
    }
};

// [2] 언어 변경 함수
function changeLanguage(lang) {
    document.body.classList.remove('lang-ko', 'lang-en', 'lang-zh', 'lang-ja');
    document.body.classList.add('lang-' + lang);

    const data = translations[lang];
    if (!data) return;
    currentLang = lang;

    // 1. 대분류 타이틀 (Step 1 ~ Step 5) 및 힌트 텍스트
    const titles = document.querySelectorAll('.section-title');
    const hints = document.querySelectorAll('.subtitle-hint');

    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach((btn, i) => {
        if (data.tabs && data.tabs[i]) {
            // 버튼 내부의 숫자 span(tab-num)을 찾습니다.
            const tabNumSpan = btn.querySelector('.tab-num');
            if (tabNumSpan) {
                // 숫자 span은 그대로 두고, 그 뒤의 텍스트 노드만 변경합니다.
                btn.innerHTML = ''; // 일단 비우고
                btn.appendChild(tabNumSpan); // 숫자를 다시 넣고
                btn.appendChild(document.createTextNode(' ' + data.tabs[i])); // 새 명칭 추가
            }
        }
    });
    
    // Step 1: 팀명
    if(titles[0]) titles[0].childNodes[0].textContent = data.step1 + " "; 
    if(hints[0]) hints[0].innerText = data.teamPlace;
    if(document.getElementById('team')) document.getElementById('team').placeholder = data.teamPlace;

    // Step 2: 인원
    if(titles[1]) titles[1].childNodes[0].textContent = data.step2 + " ";
    if(hints[1]) hints[1].innerText = data.ageInfo;
    const labels = document.querySelectorAll('.slim-label');
    if(labels[0]) labels[0].innerText = data.adult;
    if(labels[1]) labels[1].innerText = data.youth;

    // Step 3: 방 사이즈
    if(titles[2]) titles[2].childNodes[0].textContent = data.step3 + " ";
    if(hints[2]) hints[2].innerText = data.noExtra;
    const fastText = document.querySelector('.fast-text-inline');
    if(fastText) fastText.innerText = data.fastRoom;

    const sizeNames = document.querySelectorAll('.size-name');
    const sizeInfos = document.querySelectorAll('.size-info');
    if(sizeNames.length >= 3) {
        sizeNames[0].innerText = data.rooms.small.name;
        sizeInfos[0].innerText = data.rooms.small.info;
        sizeNames[1].innerText = data.rooms.medium.name;
        sizeInfos[1].innerText = data.rooms.medium.info;
        sizeNames[2].innerText = data.rooms.large.name;
        sizeInfos[2].innerText = data.rooms.large.info;
    }

    const sizeInfo2 = document.querySelector('.size-info2');
    if (sizeInfo2) sizeInfo2.innerText = data.roomWarning;

    // Step 4: 난이도 (난이도 가이드 부분)
    if(titles[3]) titles[3].childNodes[0].textContent = data.step4 + " ";
    if(hints[3]) hints[3].innerText = data.starHint;
    const guideRange = document.querySelectorAll('.guide-range span');
    if(guideRange.length >= 2) {
        guideRange[0].innerText = "🌿 " + data.low;
        guideRange[1].innerText = "🔥 " + data.high;
    }
    const guideOrder = document.querySelector('.guide-order');
    if(guideOrder) {
        // innerText 대신 innerHTML을 사용하여 span 태그와 색상을 유지합니다.
        guideOrder.innerHTML = data.order; 
    }

    // 난이도 이름 및 태그 (정규맵 & 테마맵)
    const levelSectionLabels = document.querySelectorAll('.level-section-label');
    if(levelSectionLabels[0]) levelSectionLabels[0].innerText = data.regMap;
    if(levelSectionLabels[1]) {
        levelSectionLabels[1].childNodes[0].textContent = data.themeMap;
        const themeHint = levelSectionLabels[1].querySelector('.subtitle-hint');
        if(themeHint) themeHint.innerText = data.themeInfo;
    }

    const levelNames = document.querySelectorAll('.level-name');
    const introTags = document.querySelectorAll('.intro-tag');
    
    // 명칭 매핑 (순서대로)
    const mapKeys = ['basic', 'easy', 'normal', 'hard', 'challenger', 'toddler', 'summer', 'space', 'santa'];
    const tagKeys = ['first', 'first', 'exp', 'afterNormal', 'afterHard', 'first'];

    levelNames.forEach((el, i) => {
        if(mapKeys[i]) el.innerText = data.levels[mapKeys[i]];
    });
    introTags.forEach((el, i) => {
        if(tagKeys[i]) el.innerText = data.tags[tagKeys[i]];
    });

    // Step 5: 방문자 정보
    if(titles[4]) titles[4].childNodes[0].textContent = data.step5 + " ";
    const nameHint = document.getElementById('name-hint');
    if(nameHint) nameHint.innerText = data.onePersonOnly;
    if(document.getElementById('name')) document.getElementById('name').placeholder = data.namePlace;
    if(document.getElementById('phone')) document.getElementById('phone').placeholder = data.phonePlace;

    // 안전 수칙 박스
    const warningTitle = document.querySelector('.warning-title');
    if(warningTitle) warningTitle.innerText = data.warningTitle;
    const warningPs = document.querySelectorAll('.warning-box p');
    if(warningPs.length >= 4) {
        warningPs[0].innerText = data.warning1;
        warningPs[1].innerText = data.warning2;
        warningPs[2].innerText = data.warning3;
        warningPs[3].innerText = data.warning4;
    }

    // 동의 및 버튼
    const agreeText = document.querySelector('.agree-text');
    if(agreeText) agreeText.innerText = data.agree;
    const submitBtn = document.querySelector('.submit-text');
    if(submitBtn) submitBtn.innerText = data.submit;

    // 네비게이션 버튼 (이전/다음)
    const prevBtns = document.querySelectorAll('.arrow-btn.prev .btn-text');
    const nextBtns = document.querySelectorAll('.arrow-btn.next .btn-text');
    const navTexts = { ko: ['이전 단계', '다음 단계'], en: ['Previous', 'Next'], zh: ['上一步', '下一步'], ja: ['前へ', '次へ'] };
    
    prevBtns.forEach(btn => btn.innerText = navTexts[lang][0]);
    nextBtns.forEach(btn => btn.innerText = navTexts[lang][1]);

    // 국기 업데이트 UI
    const langMap = { 'ko': '🇰🇷 KO', 'en': '🇺🇸 EN', 'zh': '🇨🇳 ZH', 'ja': '🇯🇵 JA' };
    const selFlag = document.querySelector('.selected-lang .flag-icon');
    const selText = document.querySelector('.selected-lang .lang-text');
    if(selFlag) selFlag.innerText = langMap[lang].split(' ')[0];
    if(selText) selText.innerText = langMap[lang].split(' ')[1];
}

// [3] 인원 카운터 로직
function updateCount(targetId, delta) {
    const inputEl = document.getElementById(targetId);
    let currentVal = parseInt(inputEl.value) || 0;
    let newVal = currentVal + delta;
    if (newVal < 0) newVal = 0;
    inputEl.value = newVal;
}

function activateTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.target === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === tabId);
    });
}

// [4] DOM 로드 후 실행될 초기화 로직
document.addEventListener('DOMContentLoaded', function() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(button => {
        button.addEventListener('click', function() {
            recordTeamInputTrace(`tab:${this.dataset.target || ''}`);
            activateTab(this.dataset.target);
        });
    });
    // 1. 팀명 10자 제한 실시간 감시
    const teamInput = document.getElementById('team');
    if (teamInput) {
        teamInput.addEventListener('input', function(event) {
            if (this.value.length > 10) {
                this.value = this.value.slice(0, 10);
            }
            recordTeamInputTrace('input', event);
        });
        ['focus', 'change', 'blur', 'compositionstart', 'compositionend'].forEach(eventName => {
            teamInput.addEventListener(eventName, event => recordTeamInputTrace(eventName, event));
        });
    }

    // 2. 언어 선택 드롭다운 토글 (모바일 대응)
    const langSelector = document.querySelector('.selected-lang');
    const langList = document.querySelector('.lang-list');
    
    if (langSelector) {
        langSelector.addEventListener('click', function(e) {
            e.stopPropagation();
            langList.style.display = langList.style.display === 'block' ? 'none' : 'block';
        });
    }

    document.addEventListener('click', function() {
        if (langList) langList.style.display = 'none';
    });
});

// [5] 데이터 전송 (기본 기능 + Socket.IO 연결)
if (typeof io !== 'undefined') {
    window.socket = io({
        transports: ['polling', 'websocket'],
        upgrade: false,
        reconnection: true
    });
}

function getSelectedRadioValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}
let currentLang = 'ko';


// [1] 포커스를 돌려줄 대상을 저장할 전역 변수
let pendingFocusElement = null;

// [1] 기존 alert()를 대체하는 함수
function showCustomAlert(message, targetId = null) {
    document.getElementById('modal-message').innerText = message;
    document.getElementById('custom-alert').style.display = 'flex';

    // 포커스할 대상이 있다면 저장해둠
    if (targetId) {
        pendingFocusElement = targetId;
    } else {
        pendingFocusElement = null;
    }
}

// [2] 모달 닫기 함수
function closeModal() {
    document.getElementById('custom-alert').style.display = 'none';
    
    const msg = document.getElementById('modal-message').innerText;
    const alertData = translations[currentLang].alerts;

    // 1. 인원수 부족 알럿이었을 경우 (포커스 없이 탭만 이동)
    if (msg === alertData.noCount) {
        activateTab('tab-info'); // 첫 번째 탭으로 이동만 시킴
        return; 
    }

    // 2. 성공 시 초기화
    if (msg.includes("성공") || msg.includes("완료")) {
        resetFormFields();
        return;
    }

    // 3. 일반적인 입력 누락 (팀명, 성함 등) 시 포커스 처리
    if (pendingFocusElement) {
        const target = document.getElementById(pendingFocusElement);
        if (target) {
            // 해당 요소가 속한 탭으로 먼저 이동
            if (pendingFocusElement === 'team') activateTab('tab-info');
            else if (pendingFocusElement === 'name' || pendingFocusElement === 'phone') activateTab('tab-contact');

            setTimeout(() => {
                target.focus();
            }, 150);
        }
    }
}


const successSound = new Audio('/static/sounds/submit_success.mp3');
let walkinSubmitInFlight = false;
let walkinSubmissionId = '';
let teamInputTrace = [];

function recordTeamInputTrace(eventName, event = null) {
    const teamInput = document.getElementById('team');
    if (!teamInput) return;
    teamInputTrace.push({
        event: String(eventName || ''),
        value: String(teamInput.value || ''),
        data: String(event?.data || ''),
        inputType: String(event?.inputType || ''),
        at: Date.now()
    });
    if (teamInputTrace.length > 30) teamInputTrace = teamInputTrace.slice(-30);
}

function getWalkinSubmissionId() {
    if (walkinSubmissionId) return walkinSubmissionId;
    walkinSubmissionId = globalThis.crypto?.randomUUID?.()
        || `walkin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return walkinSubmissionId;
}

function setWalkinSubmitBusy(isBusy) {
    const button = document.querySelector('.submit-btn-capsule');
    if (!button) return;
    button.disabled = isBusy;
    button.classList.toggle('is-submitting', isBusy);
    button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

async function sendWalkInData() {
    if (walkinSubmitInFlight) return;
    // 현재 언어에 맞는 알림 문구 사전 가져오기
    const alertData = translations[currentLang].alerts;

    const adultCount = parseInt(document.getElementById('adult_count').value || '0', 10) || 0;
    const childCount = parseInt(document.getElementById('child_count').value || '0', 10) || 0;

    // 1. 필수 입력값 체크 (팀명 추가 추천)

    // 팀명 체크
    const teamValue = document.getElementById('team').value.trim();
    if (!teamValue) {
        // 팀명 입력창이 'tab-info' 탭에 있다고 가정할 때
        activateTab('tab-info'); 
        showCustomAlert(alertData.noTeam, 'team');
        return;
    }

    // 인원 체크 (인원 입력창은 보통 readonly이므로 포커스 대신 탭 이동만)
    const totalCount = parseInt(document.getElementById('adult_count').value) + 
                       parseInt(document.getElementById('child_count').value);
    if (totalCount <= 0) {
        activateTab('tab-info');
        showCustomAlert(alertData.noCount);
        return;
    }

    // 예약자 성함 체크
    const nameValue = document.getElementById('name').value.trim();
    if (!nameValue) {
        activateTab('tab-info'); // 성함 입력창이 있는 탭으로 이동
        showCustomAlert(alertData.noName, 'name');
        return;
    }

    const isAgreed = document.getElementById('is_agreed').checked;
    if (!isAgreed) {
        showCustomAlert(alertData.noAgree);
        setTimeout(() => {
            activateTab('tab-contact');
            document.getElementById('is_agreed').focus();
        }, 10);
        return;
    }

    const payload = {
        name: nameValue,
        team: teamValue,
        level: getSelectedRadioValue('level'),
        adult_count: adultCount,
        child_count: childCount,
        room_size: getSelectedRadioValue('room_size'),
        room_fast: document.getElementById('room_fast').checked,
        phone: document.getElementById('phone').value.trim(),
        is_agreed: isAgreed,
        client_submission_id: getWalkinSubmissionId(),
        team_input_trace: teamInputTrace.slice(-30)
    };

    walkinSubmitInFlight = true;
    setWalkinSubmitBusy(true);
    try {
        const res = await fetch('/api/walkin/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            // 웹소켓으로 walkin_added 이벤트 전송
            if (window.socket && window.socket.emit) {
                window.socket.emit('walkin_added');
            }
            successSound.play();
            showCustomAlert(alertData.success); // "신청 완료!"
            resetFormFields();
            walkinSubmissionId = '';
            teamInputTrace = [];
            walkinSubmitInFlight = false;
            setWalkinSubmitBusy(false);
            return;
        }

        // 서버 에러 응답 처리
        let message = alertData.error; // 기본 에러 메시지
        try {
            const data = await res.json();
            if (data?.message) message = data.message;
        } catch (e) {}
        showCustomAlert(message);
        walkinSubmitInFlight = false;
        setWalkinSubmitBusy(false);

    } catch (e) {
        // 네트워크 연결 실패 등
        showCustomAlert(alertData.error);
        walkinSubmitInFlight = false;
        setWalkinSubmitBusy(false);
    }
}

// 전체화면 유지하며 입력값만 지우는 함수
function resetFormFields() {
    // 텍스트/번호 입력 초기화
    document.getElementById('team').value = '';
    document.getElementById('name').value = '';
    document.getElementById('phone').value = '';
    document.getElementById('adult_count').value = '0';
    document.getElementById('child_count').value = '0';
    document.getElementById('is_agreed').checked = false;
    document.getElementById('room_fast').checked = false;

    // 라디오 버튼 초기화 (기본값 설정)
    const defaultRoom = document.querySelector('input[name="room_size"][value="소형"]');
    if (defaultRoom) defaultRoom.checked = true;

    const defaultLevel = document.querySelector('input[name="level"][value="ㅂ"]');
    if (defaultLevel) defaultLevel.checked = true;

    // 첫 번째 탭으로 돌아가기 (선택 사항)
    activateTab('tab-info');
}

function startKioskMode() {
    const docEl = document.documentElement;
    const btn = document.getElementById('fullscreen-btn');

    // 1. 전체 화면 요청 (브라우저 호환성 대응)
    if (docEl.requestFullscreen) {
        docEl.requestFullscreen();
    } else if (docEl.webkitRequestFullscreen) { // Safari/Chrome 구버전
        docEl.webkitRequestFullscreen();
    } else if (docEl.msRequestFullscreen) { // IE11
        docEl.msRequestFullscreen();
    }

    // 2. 버튼 숨기기
    btn.style.display = 'none';
}

// 탭 전환 함수
function switchTab(targetId) {
    // 1. 모든 탭 버튼과 패널에서 active 클래스 제거
    const tabs = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');

    tabs.forEach(tab => tab.classList.remove('active'));
    panels.forEach(panel => panel.classList.remove('active'));

    // 2. 클릭한 타겟에 해당하는 버튼과 패널에 active 클래스 추가
    const targetBtn = document.querySelector(`.tab-btn[data-target="${targetId}"]`);
    const targetPanel = document.getElementById(targetId);

    if (targetBtn && targetPanel) {
        targetBtn.classList.add('active');
        targetPanel.classList.add('active');
        
        // 3. 페이지 상단으로 스크롤 (선택 사항)
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// (선택 사항) 사용자가 전체 화면을 수동으로 종료했을 때 버튼을 다시 보여주고 싶다면 아래 코드 추가
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        document.getElementById('fullscreen-btn').style.display = 'block';
    }
});

document.addEventListener('DOMContentLoaded', function() {
    // [1] 팀명 입력창에서 엔터 -> 인원 설정으로 이동 (탭은 유지)
    const teamInput = document.getElementById('team');
    if (teamInput) {
        teamInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault(); // 엔터 키의 기본 동작(줄바꿈 등) 방지
                teamInput.blur();
            }
        });
    }

    // [2] 성함 입력창에서 엔터 -> 전화번호 입력창으로 포커스
    const nameInput = document.getElementById('name');
    if (nameInput) {
        nameInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('phone').focus();
            }
        });
    }

    // [3] 전화번호 입력창에서 엔터 -> 신청하기 버튼 실행
    const phoneInput = document.getElementById('phone');
    if (phoneInput) {
        phoneInput.addEventListener('input', function(e) {
            // 숫자가 아닌 모든 문자를 제거 (정규식 사용)
            const cleaned = this.value.replace(/[^0-9]/g, '');
            this.value = cleaned;
        });
        phoneInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                // 키보드가 화면을 가리지 않도록 포커스를 해제(blur)하고 신청 실행
                phoneInput.blur(); 
                sendWalkInData();
            }
        });
    }
});
