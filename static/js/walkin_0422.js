/**
 * 점핑배틀 수원영통점 워크인 대시보드 스크립트
 * 기능: 다국어 번역, 인원 카운터, 팀명 글자수 제한, 데이터 전송
 */

// [1] 다국어 데이터 사전
const translations = {
    ko: {
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
        order: "유아  →  베이직  →  여름  →  이지  →  우주  →  노멀  →  산타  →  하드  →  챌린저",
        regMap: "정규맵",
        themeMap: "테마맵",
        themeInfo: "테마맵은 난이도가 섞여있습니다. 평균적인 난이도로 안내합니다.",
        step5: "Step 5. 방문자 정보",
        namePlace: "성함",
        phonePlace: "전화번호",
        warningTitle: "⚠️ 安全利用ルール (必読)",
        warning1: "• 소아·청소년 광과민성 발작 주의 (관련 증상 시 체험 금지)",
        warning2: "• 과격한 플레이 금지! 부주의로 인한 부상은 책임지지 않습니다.",
        warning3: "• 쓸림 주의: 바닥 단차로 인해 기어 다니거나 슬라이딩 시 맨살이 쓸릴 수 있습니다.",
        warning4: "★ 어린이는 보호자의 각별한 주의 부탁드립니다!",
        agree: "안전 수칙 확인 및 개인정보 수집 동의 (필수)",
        submit: "신청하기",
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
        step1: "Step 1. Team Info",
        teamPlace: "Team Name (Max 10 chars)",
        step2: "Step 2. Number of People",
        ageInfo: "Youth rates apply for ages 5 to 19.",
        adult: "Adult",
        youth: "Youth",
        step3: "Step 3. Select Room Size",
        noExtra: "No extra charge for room size.",
        fastRoom: "⚡ Enter the fastest available room",
        step4: "Step 4. Select Difficulty",
        low: "Easy",
        high: "Hard",
        order: "Toddler  →  Basic  →  Summer  →  Easy  →  Space  →  Normal  →  Santa  →  Hard  →  Challenger",
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
        step1: "第一步. 团队信息",
        teamPlace: "团队名称 (最多10字)",
        step2: "第二步. 输入人数",
        ageInfo: "5至19岁的青少年适用优惠价格。",
        adult: "成人",
        youth: "青少年",
        step3: "第三步. 选择房间大小",
        noExtra: "房间大小无额外费用。",
        fastRoom: "⚡ 无论大小，进入最快的房间",
        step4: "第四步. 选择难度",
        low: "简单",
        high: "困难",
        order: "幼儿  →  基础  →  夏天  →  初级  →  宇宙  →  普通  →  圣诞  →  困难  →  挑战者",
        regMap: "常规地图",
        themeMap: "主题地图",
        themeInfo: "主题地图难度混杂，显示为平均值。",
        step5: "第五步. 访客信息",
        namePlace: "姓名",
        phonePlace: "电话号码",
        warningTitle: "⚠️ 安全守则 (必读)",
        warning1: "• 儿童及青少年光敏性癫痫警告 (如有相关症状请勿体验)",
        warning2: "• 禁止粗暴玩耍！因疏忽导致的受伤概不负责。",
        warning3: "• 小心擦伤：地板高度差可能导致皮肤擦伤，请勿在地上爬行或滑行。",
        warning4: "★ 请家长务必密切看管好您的孩子！",
        agree: "确认安全守则及同意个人信息收集 (必填)",
        submit: "提交",
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
        step1: "Step 1. チーム情報",
        teamPlace: "팀명 (최대 10자)",
        step2: "Step 2. 人数入力",
        ageInfo: "5歳〜19歳は青少年料金が適用されます。",
        adult: "大人",
        youth: "青少年",
        step3: "Step 3. ルームサイズ選択",
        noExtra: "ルームサイズによる追加料金はありません。",
        fastRoom: "⚡ サイズに関係なく最短で入場",
        step4: "Step 4. 難易度選択",
        low: "易しい",
        high: "難しい",
        order: "キッズ  →  ベーシック  →  サマー  →  イージー  →  宇宙  →  ノーマル  →  サンタ  →  ハイド  →  チャレンジャー",
        regMap: "レギュラーマップ",
        themeMap: "テーママップ",
        themeInfo: "テーママップは難易度が混在しています。平均で表示します。",
        step5: "Step 5. 訪問者情報",
        namePlace: "お名前",
        phonePlace: "電話番号",
        warningTitle: "⚠️ 안전 이용 수칙 (필독)",
        warning1: "• 子供・青少年の光感受性発作にご注意ください (症状がある場合は体験禁止)",
        warning2: "• 過激なプレイ禁止！不注意による怪我は責任を負いかねます。",
        warning3: "• 擦り傷注意：床の段差により皮膚を擦りむく恐れがあります。這ったり滑ったりしないでください。",
        warning4: "★ お子様には保護者の方の細心の注意をお願いいたします！",
        agree: "安全規約の確認および個人情報の収集に同意 (必須)",
        submit: "申し込む",
        rooms: {
            small: { name: "小型", info: "2-4人" },
            medium: { name: "中型", info: "3-6人" },
            large: { name: "大型", info: "5人以上" }
        },
        levels: {
            basic: "ベーシック", easy: "イージー", normal: "ノーマル", hard: "ハード", challenger: "チャレンジャー",
            toddler: "キッズ", summer: "サマー", space: "宇宙", santa: "サンタ"
        },
        tags: {
            first: "初心者",
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
    const data = translations[lang];
    if (!data) return;
    currentLang = lang;

    // 대분류 타이틀 및 플레이스홀더
    const titles = document.querySelectorAll('.section-title');
    const descs = document.querySelectorAll('.section-desc');
    const labels = document.querySelectorAll('.slim-label');
    
    titles[0].innerText = data.step1;
    document.getElementById('team').placeholder = data.teamPlace;

    titles[1].innerText = data.step2;
    descs[0].innerText = data.ageInfo;
    labels[0].innerText = data.adult;
    labels[1].innerText = data.youth;

    titles[2].innerText = data.step3;
    descs[1].innerText = data.noExtra;
    document.querySelector('.fast-text-inline').innerText = data.fastRoom;

    // 방 사이즈 이름 (소형, 중형, 대형)
    const sizeNames = document.querySelectorAll('.size-name');
    const sizeInfos = document.querySelectorAll('.size-info');

    sizeNames[0].innerText = data.rooms.small.name;
    sizeInfos[0].innerText = data.rooms.small.info;

    sizeNames[1].innerText = data.rooms.medium.name;
    sizeInfos[1].innerText = data.rooms.medium.info;

    sizeNames[2].innerText = data.rooms.large.name;
    sizeInfos[2].innerText = data.rooms.large.info;

    titles[3].innerText = data.step4;
    document.querySelectorAll('.level-section-label')[0].innerText = data.regMap;
    document.querySelectorAll('.level-section-label')[1].innerText = data.themeMap;
    document.querySelector('.theme-desc').innerText = data.themeInfo;

    // 난이도 명칭 및 개별 태그 (정규맵 0~4, 테마맵 5~8)
    const levelNames = document.querySelectorAll('.level-name');
    const tags = document.querySelectorAll('.intro-tag');

    document.querySelector('.guide-low').innerText = data.low;
    document.querySelector('.guide-high').innerText = data.high;
    document.querySelector('.guide-order').innerText = data.order;

    // 정규맵 세팅
    levelNames[0].innerText = data.levels.basic;      tags[0].innerText = data.tags.first;
    levelNames[1].innerText = data.levels.easy;       tags[1].innerText = data.tags.first;
    levelNames[2].innerText = data.levels.normal;     tags[2].innerText = data.tags.exp;
    levelNames[3].innerText = data.levels.hard;       tags[3].innerText = data.tags.afterNormal;
    levelNames[4].innerText = data.levels.challenger; tags[4].innerText = data.tags.afterHard;

    // 테마맵 세팅 (현재 HTML에 태그가 있는 유아맵[5]만 우선 적용)
    levelNames[5].innerText = data.levels.toddler;    if(tags[5]) tags[5].innerText = data.tags.first;
    levelNames[6].innerText = data.levels.summer;
    levelNames[7].innerText = data.levels.space;
    levelNames[8].innerText = data.levels.santa;

    // Step 5. 방문자 정보 및 안전 수칙 번역
    titles[4].innerText = data.step5;
    document.getElementById('name').placeholder = data.namePlace;
    document.getElementById('phone').placeholder = data.phonePlace;

    const warningBox = document.querySelector('.warning-box');
    if (warningBox) {
        // 타이틀 변경
        warningBox.querySelector('.warning-title').innerText = data.warningTitle;
        
        // p 태그들 순서대로 변경 (p 태그가 4개인 구조)
        const warningPs = warningBox.querySelectorAll('p');
        if (warningPs.length >= 4) {
            warningPs[0].innerText = data.warning1;
            warningPs[1].innerText = data.warning2;
            warningPs[2].innerText = data.warning3;
            warningPs[3].innerText = data.warning4;
        }
    }

    // 동의 체크박스 텍스트 변경
    const agreeText = document.querySelector('.agree-text');
    if (agreeText) agreeText.innerText = data.agree;

    const submitBtn = document.querySelector('.submit-btn');
    if (submitBtn) submitBtn.innerText = data.submit;

    // 상단 국기 UI 업데이트
    const langMap = { 'ko': '🇰🇷 KO', 'en': '🇺🇸 EN', 'zh': '🇨🇳 ZH', 'ja': '🇯🇵 JA' };
    document.querySelector('.selected-lang .flag-icon').innerText = langMap[lang].split(' ')[0];
    document.querySelector('.selected-lang .lang-text').innerText = langMap[lang].split(' ')[1];
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
            activateTab(this.dataset.target);
        });
    });
    // 1. 팀명 10자 제한 실시간 감시
    const teamInput = document.getElementById('team');
    if (teamInput) {
        teamInput.addEventListener('input', function() {
            if (this.value.length > 10) {
                this.value = this.value.slice(0, 10);
            }
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
    window.socket = io();
}

function getSelectedRadioValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}
let currentLang = 'ko';

async function sendWalkInData() {
    // 현재 언어에 맞는 알림 문구 사전 가져오기
    const alertData = translations[currentLang].alerts;

    const adultCount = parseInt(document.getElementById('adult_count').value || '0', 10) || 0;
    const childCount = parseInt(document.getElementById('child_count').value || '0', 10) || 0;
    
    const payload = {
        name: document.getElementById('name').value.trim(),
        team: document.getElementById('team').value.trim(),
        level: getSelectedRadioValue('level'),
        adult_count: adultCount,
        child_count: childCount,
        room_size: getSelectedRadioValue('room_size'),
        room_fast: document.getElementById('room_fast').checked,
        phone: document.getElementById('phone').value.trim(),
        is_agreed: document.getElementById('is_agreed').checked
    };

    // 1. 필수 입력값 체크 (팀명 추가 추천)
    if (!payload.team) {
        alert(alertData.noTeam); 
        return;
    }

    if(!payload.name || !payload.is_agreed) {
        // 성함 또는 동의 체크 누락 시
        alert(!payload.name ? alertData.noName : alertData.noAgree);
        return;
    }

    // 2. 인원 체크
    if ((adultCount + childCount) <= 0) {
        alert(alertData.noCount);
        return;
    }

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
            alert(alertData.success); // "신청 완료!"
            location.reload();
            return;
        }

        // 서버 에러 응답 처리
        let message = alertData.error; // 기본 에러 메시지
        try {
            const data = await res.json();
            if (data?.message) message = data.message;
        } catch (e) {}
        alert(message);

    } catch (e) {
        // 네트워크 연결 실패 등
        alert(alertData.error);
    }
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

// (선택 사항) 사용자가 전체 화면을 수동으로 종료했을 때 버튼을 다시 보여주고 싶다면 아래 코드 추가
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        document.getElementById('fullscreen-btn').style.display = 'block';
    }
});