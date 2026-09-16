// Google Apps Script original backup supplied by the user.
// Saved: 2026-09-15 (Asia/Seoul)

function checkNaverBookingEmails() {
  var intervalSeconds = 10;
  var totalRuns = 6;

  for (var run = 0; run < totalRuns; run++) {
    var startTime = new Date().getTime();
    processEmails();

    if (run < totalRuns - 1) {
      var endTime = new Date().getTime();
      var executionTime = endTime - startTime;
      var sleepTime = (intervalSeconds * 1000) - executionTime;

      if (sleepTime > 0) {
        Utilities.sleep(sleepTime);
      }
    }
  }
}

function processEmails() {
  var searchQuery = 'from:naverbooking_noreply@navercorp.com subject:"네이버 예약" is:unread';
  var threads = GmailApp.search(searchQuery);

  if (threads.length === 0) return;

  var webhookUrl = "http://jupping17.iptime.org:8080/api/naver-bookings/webhook";

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = messages.length - 1; j >= 0; j--) {
      var message = messages[j];

      if (message.isUnread()) {
        var cleanBody = message.getPlainBody();

        var options = {
          "method": "post",
          "contentType": "application/json",
          "payload": JSON.stringify({ "content": cleanBody }),
          "muteHttpExceptions": true
        };

        try {
          var response = UrlFetchApp.fetch(webhookUrl, options);

          if (response.getResponseCode() === 200) {
            message.markRead();
          }
          break;
        } catch (e) {
          Logger.log("[에러 발생] 웹훅 전송 단계에서 터짐: " + e.toString());
        }
      }
    }
  }
}

function testDirectWebhook() {
  var url = "http://jupping17.iptime.org:8080/api/naver-bookings/webhook";

  var mockPayload = {
    "content": "Content-Transfer-Encoding: base64\n\n" +
               "예약번호 20260519-PERFECT01\n" +
               "예약자명 홍길동님\n" +
               "이용일시 2026.05.19 15:00\n" +
               "이용예정 C1룸\n" +
               "예약확정 완료"
  };

  var options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(mockPayload)
  };

  try {
    var res = UrlFetchApp.fetch(url, options);
    Logger.log("응답 결과: " + res.getContentText());
  } catch(e) {
    Logger.log("통신 에러: " + e.toString());
  }
}
