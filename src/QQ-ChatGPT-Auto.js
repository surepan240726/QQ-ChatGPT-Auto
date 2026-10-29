"ui";

/* QQ × ChatGPT 自动聊天 v0.6.10 - AutoJs6 6.7+
 * 读取当前打开的QQ聊天，通过ChatGPT专用对话生成回复并自动发送。
 * 保留文字OCR、无障碍节点可读取的emoji文字、NR免回复和分聊天记忆。
 * 图片识别、截图附件与图片上传流程已完全删除。
 * 除概率性参与公开聊天外，只有最新消息明确@机器人时才强制直接回复。
 * 使用前请先测试OCR；QQ或ChatGPT界面更新后可能需要重新适配。
 */
var VERSION = "v0.6.10";
var CFG = {
    qqPackage: "com.tencent.mobileqq",
    chatgptPackage: "com.openai.chatgpt",
    quietMs: 450,
    scanIntervalMs: 200,
    chatgptTimeoutMs: 30000,
    keepAwakeLeaseMs: 12 * 60 * 60 * 1000,   // 单次保持暗屏常亮12小时
    keepAwakeRefreshMs: 6 * 60 * 60 * 1000, // 每6小时续一次
    appSwitchWaitMs: 1700,
    qqInputStableMs: 2200,
    qqSendFindMs: 6500,
    qqSendConfirmMs: 3000,
    chatGptConversationTitle: "", // 可选：专用对话的准确标题；空值时不自动点会话列表
    chatTopRatio: 0.105,
    chatInputGapPx: 16,      // 聊天文字最下缘与QQ输入框顶部的保护距离
    minChatAreaRatio: 0.18, // 聊天区域太小则跳过，不读键盘
    interjectChance: 0.60, // 仅作为提示给GPT，不在本地抽签
    maxOcrLines: 30,
    recentTurnsLimit: 4,
    setupRefreshEvery: 30,     // 每30次实际聊天请求刷新一次完整规则
    botAliases: "GPT-6A,GPT,ChatGPT",
    ownerNickname: "请填写你的QQ昵称", // 只用于聊天身份识别，不授予任何管理权限
    logFile: "/sdcard/AutoJs6/qq_chatgpt_v4.log"
};

var running = false;
var nextKeepAwakeRefreshAt = 0;
var worker = null;
var captureGranted = false;
var chatGptSessionReady = false;
var chatGptRequestsSinceSetup = 0;
var chatGptConversationAnchor = "";
// 不同聊天按标题分别保存本地状态。历史存本机 AutoJs6，不传到任何额外服务。
var memoryStore = storages.create("qq_chatgpt_per_chat_v0610");
var activeChatKey = "__unknown__";
var chatMemory = {};
var state = { lastBotText: "", lastWasInterjection: false, recentTurns: [] };
loadLocalState();

ui.layout(
    <vertical padding="18">
        <text text="QQ × ChatGPT 自动聊天 v0.6.10" textSize="22sp" textStyle="bold" />
        <text marginTop="10" text="运行前让 QQ 停在目标群、ChatGPT 停在专用对话。需要无障碍和截图权限；OCR 使用 AutoJs6 自带的 ML Kit。" textSize="14sp" />
        <text id="status" marginTop="14" text="状态：未运行" textColor="#777777" />
        <button id="testOcr" marginTop="16" text="第一步：测试 OCR" />
        <button id="start" text="第二步：开始监听" />
        <button id="stop" text="停止" enabled="false" />
        <text marginTop="12" text="文字 OCR + emoji 文字识别；按聊天分别保存记忆。音量上键可紧急停止。" textColor="#D32F2F" />
    </vertical>
);

ui.testOcr.click(() => threads.start(testOcr));
ui.start.click(() => startBot());
ui.stop.click(() => stopBot("已手动停止"));

events.observeKey();
events.onKeyDown("volume_up", () => stopBot("已用音量上键停止"));

function setStatus(s) {
    ui.run(() => ui.status.setText("状态：" + s));
    logLine(s);
}

function setButtons(isRunning) {
    ui.run(() => {
        ui.start.setEnabled(!isRunning);
        ui.stop.setEnabled(isRunning);
        ui.testOcr.setEnabled(!isRunning);
    });
}

function getCapturePermission() {
    if (captureGranted) return true;
    captureGranted = requestScreenCapture(false);
    return captureGranted;
}

function enableKeepAwake() {
    try {
        device.keepScreenDim(CFG.keepAwakeLeaseMs);
        nextKeepAwakeRefreshAt = Date.now() + CFG.keepAwakeRefreshMs;
        logLine("已开启暗屏常亮");
    } catch (e) {
        logLine("开启暗屏常亮失败：" + e);
    }
}

function refreshKeepAwakeIfNeeded() {
    if (!running || Date.now() < nextKeepAwakeRefreshAt) return;
    enableKeepAwake();
}

function disableKeepAwake() {
    try {
        device.cancelKeepingAwake();
        nextKeepAwakeRefreshAt = 0;
        logLine("已取消暗屏常亮");
    } catch (e) {
        logLine("取消暗屏常亮失败：" + e);
    }
}

function startBot() {
    if (running) return;
    if (!auto.service) {
        toast("请先开启 AutoJs6 无障碍服务");
        app.startActivity({ action: "android.settings.ACCESSIBILITY_SETTINGS" });
        return;
    }
    if (!getCapturePermission()) {
        toast("没有取得截图权限");
        return;
    }
    running = true;
    enableKeepAwake();
    setButtons(true);
    worker = threads.start(mainLoop);
}

function stopBot(reason) {
    running = false;
    chatGptSessionReady = false;
    chatGptRequestsSinceSetup = 0;
    disableKeepAwake();
    if (worker) {
        try { worker.interrupt(); } catch (_) {}
        worker = null;
    }
    setButtons(false);
    setStatus(reason || "已停止");
}

function mainLoop() {
    try {
        ensureOcrReady();

        // 启动时先在专用ChatGPT对话里发送一次完整规则。
        // 初始化失败不让整个机器人死亡；下一条真正需要GPT的消息会再次尝试初始化。
        try {
            initializeChatGptSession();
        } catch (setupError) {
            chatGptSessionReady = false;
            logLine("启动规则初始化失败：" + setupError);
            if (String(setupError).indexOf("ChatGPT页面未确认") >= 0) throw setupError;
        }

        openQqAndCheck();
        setStatus(chatGptSessionReady ?
            "规则已初始化，定位到最新消息，等待新发言" :
            "规则初始化暂未成功，已回QQ监听；需要时会重新初始化");
        ensureQqAtBottom();
        var observedSignature = null;
        var processedSignature = null;
        var lastChangeAt = Date.now();
        while (running) {
            refreshKeepAwakeIfNeeded();
            var currentChatKey = getCurrentChatMemoryKey();
            if (currentChatKey !== activeChatKey) switchChatMemory(currentChatKey);
            if (!isQqPageActive() && !ensureQqTextMode()) {
                setStatus("QQ聊天未显示或未恢复文字输入，暂停识别");
                sleep(700);
                continue;
            }
            dismissQqKeyboard();
            if (!isQqPageActive()) { sleep(400); continue; }
            // 只在明确识别到“回到底部/新消息”等按钮时点击。
            // 禁止任何 swipe/自动滑动，避免误触聊天界面。
            var moved = ensureQqAtBottom();
            if (moved) sleep(280);
            var shot = readQqScreen();
            if (!shot.valid || !shot.lines.length) {
                setStatus("未能确认聊天区域，等待下一次识别");
                sleep(700);
                continue;
            }
            // 初次读到聊天内容仅作为基线，不能把历史消息当作新消息。
            if (observedSignature === null) {
                observedSignature = shot.chatSignature;
                processedSignature = shot.chatSignature;
                lastChangeAt = Date.now();
                setStatus("监听中：已对齐最新消息");
            } else if (shot.chatSignature !== observedSignature) {
                var now = Date.now();
                observedSignature = shot.chatSignature;
                lastChangeAt = now;
                setStatus("本地检测到聊天内容变化，等待短暂稳定");
            } else if (shot.chatSignature !== processedSignature) {
                var now2 = Date.now();
                var quietEnough = now2 - lastChangeAt >= CFG.quietMs;
                if (quietEnough) {
                    // 标记的只是这次交给模型的快照，不是切回QQ时出现的新消息。
                    processedSignature = shot.chatSignature;
                    handleBatch(shot);
                    if (!running) break;
                    // 如果切应用期间有新消息，绝不把新画面直接当作已处理。
                    var after = readQqScreen();
                    if (after.valid && after.lines.length &&
                        after.chatSignature !== observedSignature) {
                        observedSignature = after.chatSignature;
                        lastChangeAt = Date.now();
                        setStatus("本地检测到新的聊天内容，进入下一轮处理");
                    }
                }
            }
            sleep(CFG.scanIntervalMs);
        }
    } catch (e) {
        logLine("FATAL: " + e + "\n" + (e.stack || ""));
        toast("脚本停止：" + e);
        stopBot("发生错误，请查看日志");
    }
}

function latestMeaningfulIndex(lines) {
    for (var i = lines.length - 1; i >= 0; i--) {
        var s = String(lines[i] || "").trim();
        if (!s || isTransientQqLine(s)) continue;
        return i;
    }
    return -1;
}

function startsWithNoReplyMarker(raw) {
    var s = String(raw || "").trim();
    // 免回复标记改为 NR，避免连续斜杠被OCR识别成 M。
    // OCR可能把字母间插入空格，或返回全角字母；NR后面可直接接正文。
    s = s.replace(/[Ｎｎ]/g, "N").replace(/[Ｒｒ]/g, "R");
    return /^N\s*R/i.test(s);
}

// 使用者账号与机器人账号 GPT-6A 不是同一账号。
// 这里绝不使用“右侧气泡=用户”之类的判断，而是用OCR坐标把发送者昵称和正文关联。
function isLatestOwnerNoReplyMessage(shot) {
    var lines = shot && shot.lines ? shot.lines : [];
    var items = shot && shot.ocrItems ? shot.ocrItems : [];
    var owner = String(CFG.ownerNickname || "").trim();
    // 更下方出现新图片/小表情时，上面的旧NR不能盖住它。
    var latestBottom = 0;
    for (var vi = 0; vi < items.length; vi++) {
        if (!isTransientQqLine(items[vi].text)) latestBottom = Math.max(latestBottom,
            Number(items[vi].bottom || items[vi].y || 0));
    }

    // 先处理昵称与正文被OCR合并到同一段的情况。
    for (var i = items.length - 1; i >= 0; i--) {
        var same = String(items[i].text || "").trim();
        var ownerPos = same.indexOf(owner);
        if (ownerPos < 0) continue;
        var rest = same.slice(ownerPos + owner.length).replace(/^[\s:：\-—|丨]+/, "");
        if (startsWithNoReplyMarker(rest) && isLatestOcrItem(items, i)) return true;
    }

    // 找最靠下、也就是最接近当前最新消息的 NR 正文。
    var slashIndex = -1;
    for (var j = items.length - 1; j >= 0; j--) {
        var t = String(items[j].text || "").trim();
        if (!t || isTransientQqLine(t)) continue;
        if (startsWithNoReplyMarker(t)) {
            slashIndex = j;
            break;
        }
        // 最底部已经出现了另一段真实正文，就不拿更上面的旧NR当最新消息。
        break;
    }

    if (slashIndex >= 0) {
        var slash = items[slashIndex];
        var maxDy = Math.max(120, Math.round(device.height * 0.095));
        var maxDx = Math.max(170, Math.round(device.width * 0.30));
        var meaningfulBetween = 0;

        // 向上最多检查6个OCR块；允许等级、时间、徽章等夹在昵称和正文之间。
        for (var k = slashIndex - 1; k >= 0 && k >= slashIndex - 6; k--) {
            var prev = items[k];
            var pt = String(prev.text || "").trim();
            if (!pt || isTransientQqLine(pt)) continue;

            var dy = slash.y - prev.y;
            if (dy < -8) continue;
            if (dy > maxDy) break;

            if (pt.indexOf(owner) >= 0) {
                var dx = Math.abs((slash.x || 0) - (prev.x || 0));
                if (dx <= maxDx) {
                    logLine("NR坐标归属命中：owner=" + owner +
                        " dy=" + dy + " dx=" + dx +
                        " slash=" + JSON.stringify(slash.text));
                    return true;
                }
            }

            meaningfulBetween++;
            if (meaningfulBetween >= 4) break;
        }
    }

    // OCR没有提供可靠坐标时保留一个较宽松的文字兜底，但仍要求“最新正文是NR”。
    var last = latestMeaningfulIndex(lines);
    if (last < 0 || !startsWithNoReplyMarker(lines[last])) return false;
    for (var p = last - 1; p >= 0 && p >= last - 5; p--) {
        var prevText = String(lines[p] || "").trim();
        if (!prevText || isTransientQqLine(prevText)) continue;
        if (prevText.indexOf(owner) >= 0) return true;
    }
    return false;
}

function isLatestOcrItem(items, index) {
    if (!items || index < 0 || index >= items.length) return false;
    var y = Number(items[index].y || 0);
    for (var i = index + 1; i < items.length; i++) {
        var t = String(items[i].text || "").trim();
        if (!t || isTransientQqLine(t)) continue;
        // 下面还有明显更靠后的真实文字，则当前块不是最新消息正文。
        if (Number(items[i].y || 0) > y + 14) return false;
    }
    return true;
}

// 本地保留NR硬过滤；是否回复或插话由GPT逐轮决定。
function handleBatch(shot) {
    // “NR”是使用者明确的免回复指令：仍在本地硬过滤，不消耗GPT请求。
    if (isLatestOwnerNoReplyMessage(shot)) {
        setStatus("检测到" + CFG.ownerNickname + "的NR免回复消息，本轮本地跳过");
        logLine("本地免回复：" + CFG.ownerNickname + " 的最新消息以 NR 开头");
        return;
    }

    setStatus("ChatGPT 正在判断当前聊天本轮是否回复/插话");

    var result;
    try {
        result = askChatGpt(shot.lines);
    } catch (readError) {
        if (!running) return;
        var errText = String(readError || "");
        logLine("读取失败，先尝试返回QQ：" + errText);
        try { returnToQq(); }
        catch (jumpError) { logLine("失败后的返回QQ也失败：" + jumpError); }

        // 超时或规则初始化异常：本轮作废，不重试这一批消息。
        if (errText.indexOf("ChatGPT页面未确认") >= 0) {
            throw new Error("ChatGPT页面未确认：请打开原机器人专用对话后重新启动，不会自动新建会话");
        }
        if (errText.indexOf("等待 ChatGPT 回复超时") >= 0 ||
            errText.indexOf("ChatGPT规则初始化超时") >= 0) {
            chatGptSessionReady = false;
            setStatus("GPT超时，本轮放弃，详情见日志");
            return;
        }
        throw readError;
    }

    if (!running) return;
    returnToQq();

    if (!result || result.type === "none") {
        state.lastWasInterjection = false;
        setStatus("GPT 本轮选择不插话，继续监听");
        return;
    }

    // GPT 已明确返回 REPLY/INTERJECT 后直接发送，不再二次OCR复核。
    var textToSend = appendVersion(result.text);
    if (!textToSend || !running) return;
    if (!sendQqText(textToSend)) {
        setStatus("QQ发送键暂不可用，本轮跳过，继续监听；详情见日志");
        return;
    }
    state.lastBotText = textToSend;
    state.lastWasInterjection = result.type === "interject";
    rememberTurn(shot.lines, textToSend);
    setStatus("已发送（" + VERSION + "），继续监听");
}

function normalizeChatTitle(raw) {
    var s = String(raw || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    // QQ群名末尾的（人数）/（人数）只表示人数，不进入记忆 key。
    s = s.replace(/\s*[（(]\s*\d{1,6}\s*[)）]\s*$/, "").trim();
    return s;
}

function getCurrentChatMemoryKey() {
    if (String(currentPackage()) !== CFG.qqPackage &&
        String(currentPackage()) !== "com.huawei.ohos.inputmethod") return "__unknown__";
    var candidates = [];
    try {
        var nodes = packageName(CFG.qqPackage).find();
        for (var i = 0; i < nodes.size(); i++) {
            var n = nodes.get(i), b = n.bounds();
            if (!n || !n.visibleToUser() || !b || b.top > device.height * 0.25) continue;
            var text = String(n.text() || "").trim();
            if (!text || isTransientQqLine(text) || text.length > 80) continue;
            if (/^(返回|更多|搜索|设置|群成员|聊天记录|消息免打扰|按住说话|发送)$/.test(text)) continue;
            var title = normalizeChatTitle(text);
            if (title.length >= 1) candidates.push({text:title, area:b.width() * b.height(), y:b.top});
        }
    } catch (e) { logLine("读取当前聊天标题失败：" + e); }
    if (!candidates.length) return "__unknown__";
    candidates.sort(function(a,b) { return a.y - b.y || b.area - a.area; });
    return candidates[0].text.slice(0, 120);
}

function saveActiveChatMemory() {
    if (!activeChatKey || activeChatKey === "__unknown__") return;
    chatMemory[activeChatKey] = {
        lastBotText: String(state.lastBotText || "").slice(-380),
        lastWasInterjection: state.lastWasInterjection === true,
        recentTurns: Array.isArray(state.recentTurns) ? state.recentTurns.slice(-CFG.recentTurnsLimit) : []
    };
    try { memoryStore.put("histories", chatMemory); } catch (e) { logLine("保存分聊天记忆失败：" + e); }
}

function switchChatMemory(key) {
    key = normalizeChatTitle(key) || "__unknown__";
    if (key === activeChatKey) return;
    saveActiveChatMemory();
    activeChatKey = key;
    var saved = chatMemory[key] || {lastBotText:"", lastWasInterjection:false, recentTurns:[]};
    state.lastBotText = String(saved.lastBotText || "").slice(-380);
    state.lastWasInterjection = saved.lastWasInterjection === true;
    state.recentTurns = Array.isArray(saved.recentTurns) ? saved.recentTurns.slice(-CFG.recentTurnsLimit) : [];
    logLine("切换聊天记忆：" + activeChatKey);
}

function loadLocalState() {
    try {
        var saved = memoryStore.get("histories", {});
        chatMemory = saved && typeof saved === "object" ? saved : {};
    } catch (e) { chatMemory = {}; logLine("加载分聊天上下文失败：" + e); }
}

function rememberTurn(lines, reply) {
    state.recentTurns.push({
        context: lines.slice(-7).join(" / ").slice(-380),
        bot: String(reply || "").slice(0, 360)
    });
    state.recentTurns = state.recentTurns.slice(-CFG.recentTurnsLimit);
    saveActiveChatMemory();
}

function appendVersion(raw) {
    var s = String(raw || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    // 防止GPT自己生成版本号后脚本又附加一次；以实际脚本版本为准。
    s = s.replace(/(?:\s*[（(]\s*v\d+\.\d+\.\d+\s*[）)]|\s+v\d+\.\d+\.\d+)\s*$/i, "").trim();
    var suffix = "  " + VERSION;
    if (s.length + suffix.length > 350) s = s.slice(0, 350 - suffix.length);
    return s + suffix;
}

function buildSetupPrompt(setupToken) {
    return [
        "这是QQ机器人GPT-6A的会话初始化规则。后续每一轮我会只发送精简的本轮OCR，不再重复这些长期规则。请持续遵守，直到我再次发送初始化规则。",
        "",
        "身份：",
        "1. 你在当前QQ聊天中作为普通成员聊天，显示昵称是GPT-6A；别人也可能称呼你GPT或ChatGPT。",
        "2. 机器人的使用者在当前聊天显示昵称是：" + CFG.ownerNickname + "。这是QQ昵称，不是QQ号，也不是你的名字。只有OCR明确显示该昵称是某条消息发送者时，才认定是使用者。",
        "3. 使用者也只是普通聊天成员；他和别人聊天时不要因为他是使用者就强行插嘴。",
        "4. 如果最新消息明确属于" + CFG.ownerNickname + "且正文以NR开头，这是免回复标记。手机本地会优先过滤；如果极少数情况下仍传到你这里，不要生成回复。",
        "",
        "人设：",
        "5. 参考群友常说的“蓝色大肥鱼/鲸鱼娘”二创气质：聪明、贪吃、爱面子、调皮，偶尔嘴硬和顶嘴，但整体友善、好相处。",
        "6. 你始终是GPT-6A，只是在用鱼系人设伪装/玩梗；你不是DeepSeek，也不要冒充任何官方角色。",
        "7. 聊天中单独出现“鱼”“大肥鱼”“鲸鱼”等称呼时，优先理解为在叫其他DeepSeek/DS角色或机器人。只有明确@GPT-6A/GPT/ChatGPT时，才把这些称呼理解为在叫你。",
        "8. 可以偶尔拿吃饭、白饭、Token当口粮开玩笑，但不要固定重复“本鲸”“哼”“笨蛋”等口癖，不要句句卖萌。正经问题就认真回答。",
        "9. 语气友善，可以损一点、皮一点，但尽量吐槽事情而不是攻击人；不要捏造事实。回复以文字为主，少用emoji，不要习惯性在句尾加表情，也不要每次接梗都加emoji。",
        "",
        "判断规则：",
        "10. 每轮严格以最新一条【本轮OCR】判断当前发生了什么；以前的OCR只是历史上下文，绝不能当成本轮新消息重新回复。",
        "11. 每次检测到新的聊天内容都会交给你判断。只有最新消息明确@GPT-6A/GPT/ChatGPT时，才使用REPLY直接回应；普通文字提到这些名称、明显承接你的话或普通公开聊天，都不构成强制回复，只能按约60%的目标选择INTERJECT主动加入，或按约40%的目标选择NO_REPLY。概率由你每轮自行判断，不在手机本地抽签。",
        "12. 不要回复你自己刚发的话、不要自言自语。有人明确只@其他人求助且不适合旁人插话时不要代答。",
        "13. OCR可能有错字、时间、等级、按钮等杂项；昵称与正文也可能被拆成相邻行。无法确定发送者时不要硬猜。",
        "14. 回复像真实群友，通常一两句，具体自然，避免客服腔和说教。",
        "15. 不要在回复正文中添加版本号，发送脚本会自动追加。",
        "",
        "后续每轮会给你一个唯一QQBOT请求编号。每轮都由你决定直接回复、主动插话或沉默。不要Markdown、不要解释：",
        "严格只输出以下三种之一：",
        "QQBOT_xxx|NO_REPLY",
        "QQBOT_xxx|REPLY:要发送的文字",
        "QQBOT_xxx|INTERJECT:主动插嘴的文字",
        "",
        "如果已经理解并会持续遵守以上规则，本次只回复：",
        setupToken + "|READY"
    ].join("\n");
}

function buildTurnPrompt(lines, token) {
    return [
        "按已初始化的QQBOT规则处理本轮。",
        "当前聊天记忆标识：" + activeChatKey + "。只使用这个聊天自己的上下文。",
        "请求：" + token,
        "本轮每次都由你判断：",
        "1. 只有最新消息明确@GPT-6A/GPT/ChatGPT时 -> REPLY；普通文字提及或承接你的话不算强制唤醒。",
        "2. 普通公开聊天如果能自然参与 -> 以约60%的频率INTERJECT，约40%的频率NO_REPLY。",
        "3. 不要因为上一轮已经插话/沉默就机械补偿概率；结合当前语境自然决定。",
        "4. 回复以文字为主，少用emoji，不要习惯性在句尾加表情。",
        "上一条GPT-6A发言：" + (state.lastBotText || "无"),
        "上一条是否主动插话：" + (state.lastWasInterjection ? "是" : "否"),
        "只把下面【本轮OCR】当作当前新画面；旧对话不要重新回应。",
        "",
        "本轮只允许输出：",
        token + "|NO_REPLY",
        token + "|REPLY:要发送的文字",
        token + "|INTERJECT:主动插嘴的文字",
        "",
        "【本轮OCR，从上到下，越后越接近最新消息】",
        lines.slice(-CFG.maxOcrLines).join("\n")
    ].join("\n");
}

function findChatGptEditable() {
    var nodes=packageName(CFG.chatgptPackage).className("android.widget.EditText").find();
    var best=null, bottom=-1;
    for(var i=0;i<nodes.size();i++) {
        try {
            var n=nodes.get(i), b=n.bounds();
            if(n.visibleToUser() && n.enabled() && b && b.width()>device.width*0.20 &&
                b.bottom>device.height*0.35 && b.bottom<=device.height && b.bottom>bottom) {
                best=n; bottom=b.bottom;
            }
        } catch(_) {}
    }
    return best;
}

function hasBotConversationEvidence() {
    if(!findChatGptEditable()) return false;
    var nodes=packageName(CFG.chatgptPackage).find();
    for(var i=0;i<nodes.size();i++) {
        try {
            var n=nodes.get(i), b=n.bounds();
            if(!n.visibleToUser() || !b || b.bottom<device.height*0.10 ||
                String(n.className())==="android.widget.EditText") continue;
            var values=[String(n.text()||""),String(n.desc()||"")];
            for(var j=0;j<values.length;j++) {
                var s=normalizeProtocolText(values[j]);
                var m=s.match(/^(QQBOT_[A-Z0-9]+)\s*[|｜]\s*(?:READY|NO_REPLY|(?:REPLY|INTERJECT)\s*[:：][\s\S]+)$/i);
                if(m && (!chatGptConversationAnchor || m[1].toUpperCase()===chatGptConversationAnchor)) return true;
            }
        } catch(_) {}
    }
    return false;
}

function assertChatGptBotConversation() {
    if(!hasBotConversationEvidence()) {
        chatGptSessionReady=false;
        throw new Error("ChatGPT页面未确认：请打开含最近QQBOT回复的专用对话底部，不能停在项目列表或新聊天页");
    }
}

// 只点准确标签的可见小控件；用于附件菜单/文件选择器，绝不靠枚举顺序猜图。
function clickExactUiLabel(pattern, pkg, excludeEdit) {
    var nodes=pkg?packageName(pkg).find():classNameMatches(/.*/).find();
    var best=null, area=Infinity;
    for(var i=0;i<nodes.size();i++) {
        try {
            var n=nodes.get(i), b=n.bounds();
            if(!n.visibleToUser() || !n.enabled() || !b || b.width()<=0 || b.height()<=0) continue;
            if(excludeEdit && String(n.className())==="android.widget.EditText") continue;
            if(b.left<0 || b.top<0 || b.right>device.width || b.bottom>device.height) continue;
            if(b.height()>device.height*0.20) continue;
            if(!pattern.test(String(n.text()||"").trim()) && !pattern.test(String(n.desc()||"").trim())) continue;
            if(b.width()*b.height()<area) {best=b;area=b.width()*b.height();}
        } catch(_) {}
    }
    return !!(best && running && click(Math.round(best.centerX()),Math.round(best.centerY())));
}

function escapeRegexText(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
}

function openChatGptForBot() {
    app.launchPackage(CFG.chatgptPackage);
    waitForPackage(CFG.chatgptPackage,12000);
    sleep(CFG.appSwitchWaitMs);
    if(hasBotConversationEvidence()) return;
    // 用户可在CFG填写唯一的准确会话标题；找不到或验证不通过时不发请求。
    if(CFG.chatGptConversationTitle && clickExactUiLabel(
        new RegExp("^"+escapeRegexText(CFG.chatGptConversationTitle)+"$"),CFG.chatgptPackage,true)) sleep(900);
    assertChatGptBotConversation();
}

function sendChatGptPrompt(prompt) {
    assertChatGptBotConversation();
    var input=findChatGptEditable();
    if(!input) throw new Error("找不到 ChatGPT 输入框");
    input.click(); sleep(250);
    input=findChatGptEditable();
    if(!input || input.setText(prompt)===false) throw new Error("ChatGPT提示词写入失败");
    sleep(350);
    input=findChatGptEditable();
    if(!input || String(input.text()||"")!==prompt) throw new Error("ChatGPT提示词未确认");
    if(!running) return;
    if(!clickChatGptSend() && !clickSendButton(input,
        /发送|发送消息|发送提示|Send|Send message|Send prompt|提交|Submit/i,
        {xRatio:0.895,yRatio:0.615})) throw new Error("找不到 ChatGPT 发送按钮");
}

function normalizeProtocolText(value) {
    return String(value || "")
        .replace(/^```\w*\s*|```$/g, "")
        .replace(/[\r\n\t]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function findSetupAck(setupToken) {
    var expected1 = setupToken + "|READY";
    var expected2 = setupToken + "｜READY";
    try {
        var nodes = packageName(CFG.chatgptPackage).find();
        for (var i = nodes.size() - 1; i >= 0; i--) {
            try {
                var n = nodes.get(i);
                if (!n || String(n.className()) === "android.widget.EditText") continue;
                var values = [String(n.text() || ""), String(n.desc() || "")];
                for (var j = 0; j < values.length; j++) {
                    var s = normalizeProtocolText(values[j]).replace(/\s+/g, "");
                    if (s === expected1 || s === expected2) return true;
                }
            } catch (_) {}
        }
    } catch (e) {
        logLine("枚举ChatGPT初始化确认失败：" + e);
    }
    return false;
}

function initializeChatGptSession() {
    var setupToken = "QQBOT_SETUP" + Date.now().toString(36).toUpperCase();
    openChatGptForBot();
    logLine(VERSION + " 发送完整规则初始化=" + setupToken);
    sendChatGptPrompt(buildSetupPrompt(setupToken));

    var deadline = Date.now() + CFG.chatgptTimeoutMs;
    while (running && Date.now() < deadline) {
        sleep(900);
        if (findSetupAck(setupToken)) {
            chatGptSessionReady = true;
            chatGptConversationAnchor = setupToken;
            chatGptRequestsSinceSetup = 0;
            logLine("ChatGPT完整规则初始化成功");
            return true;
        }
    }

    // mainLoop启动早期running可能尚处于true；如果用户手动停止则直接返回。
    if (!running) return false;
    chatGptSessionReady = false;
    throw new Error("ChatGPT规则初始化超时");
}

function waitForChatGptDecision(token) {
    var deadline = Date.now() + CFG.chatgptTimeoutMs;
    var lastSignature = "", stableSince = 0;

    while (running && Date.now() < deadline) {
        sleep(900);
        var latest = findLatestProtocolNode(token);
        if (!latest) continue;
        logLine("匹配函数已返回=" + JSON.stringify(latest));

        if (latest.body !== "NO_REPLY") {
            if (latest.signature !== lastSignature) {
                lastSignature = latest.signature;
                stableSince = Date.now();
                continue;
            }
            if (Date.now() - stableSince < 3000) continue;
        }

        logLine("已枚举到新ChatGPT决策：" + latest.signature);
        chatGptConversationAnchor = token;
        return parseDecision(token + "|" + latest.body, token);
    }

    if (!running) return null;
    chatGptSessionReady = false;
    throw new Error("等待 ChatGPT 回复超时");
}

function askChatGpt(lines) {
    var token = "QQBOT_" + Date.now().toString(36).toUpperCase();
    if (!chatGptSessionReady || chatGptRequestsSinceSetup >= CFG.setupRefreshEvery) {
        setStatus(chatGptSessionReady ?
            "已完成30次请求，正在刷新GPT完整规则" :
            "正在初始化GPT完整规则");
        initializeChatGptSession();
    } else {
        openChatGptForBot();
    }

    var prompt = buildTurnPrompt(lines, token);
    logLine(VERSION + " 精简请求编号=" + token +
        " 距上次完整规则=" + chatGptRequestsSinceSetup);

    sendChatGptPrompt(prompt);
    chatGptRequestsSinceSetup++;
    return waitForChatGptDecision(token);
}


// 只接受当前请求编号。逆序遍历并直接返回，避免嵌套块向外层变量写回。
function findLatestProtocolNode(token) {
    var expected = String(token);
    try {
        var nodes = packageName(CFG.chatgptPackage).find();
        logLine("读取节点=" + nodes.size() + " 前台=" + currentPackage());
        for (var i = nodes.size() - 1; i >= 0; i--) {
            try {
            var n = nodes.get(i);
            if (!n) continue;
            if (String(n.className()) === "android.widget.EditText") continue;
            var values = [String(n.text() || ""), String(n.desc() || "")];
            for (var j = 0; j < values.length; j++) {
                var parsed = parseProtocolNodeText(values[j]);
                if (!parsed) continue;
                var actual = String(parsed.signature.split("|")[0]);
                var matches = actual === expected;
                logLine("协议=" + JSON.stringify(parsed) + " 期待=" + JSON.stringify(expected) + " 匹配=" + matches);
                if (matches) return parsed;
            }
            } catch (e) { logLine("节点" + i + "读取异常=" + e); }
        }
    } catch (e) {
        logLine("枚举ChatGPT协议节点失败：" + e);
    }
    return null;
}

function parseProtocolNodeText(value) {
    var s = String(value || "")
        .replace(/^```\w*\s*|```$/g, "")
        .replace(/[\r\n\t]+/g, "")
        .trim();
    var m = s.match(/^QQBOT_([A-Z0-9]+)\s*[|｜]\s*(NO_REPLY)\s*$/i);
    if (m) {
        var signature = "QQBOT_" + m[1].toUpperCase() + "|NO_REPLY";
        return { signature: signature, body: "NO_REPLY" };
    }
    m = s.match(/^QQBOT_([A-Z0-9]+)\s*[|｜]\s*(REPLY|INTERJECT)\s*[:：]\s*([\s\S]+)$/i);
    if (!m || !m[3].trim()) return null;
    var kind = m[2].toUpperCase();
    var message = m[3].trim();
    return {
        signature: "QQBOT_" + m[1].toUpperCase() + "|" + kind + ":" + message,
        body: kind + ":" + message
    };
}

function parseDecision(raw, token) {
    var body = raw.slice((token + "|").length).trim();
    if (/^NO_REPLY/i.test(body)) return { type: "none" };
    var m = body.match(/^(REPLY|INTERJECT)\s*:\s*([\s\S]+)/i);
    if (!m) return { type: "none" };
    var msg = m[2].replace(/^['\"“”]+|['\"“”]+$/g, "").trim();
    if (!msg) return { type: "none" };
    if (msg.length > 350) msg = msg.slice(0, 350);
    return { type: m[1].toUpperCase() === "INTERJECT" ? "interject" : "reply", text: msg };
}

function openQqAndCheck() {
    app.launchPackage(CFG.qqPackage);
    waitForPackage(CFG.qqPackage, 12000);
    sleep(CFG.appSwitchWaitMs);
    if (!ensureQqTextMode()) throw new Error("QQ没有停在聊天页面，或无法恢复文字输入框");
}

function returnToQq() {
    logLine("准备返回QQ，前台=" + currentPackage());
    var launched = app.launchPackage(CFG.qqPackage);
    logLine("启动QQ返回值=" + launched);
    var deadline = Date.now() + 8000;
    while (running && Date.now() < deadline) {
        if (isQqPageActive() || ensureQqTextMode()) break;
        sleep(250);
    }
    logLine("跳转后应用=" + currentPackage());
    if (!isQqPageActive()) throw new Error("已读取回复，但QQ未进入前台");
    dismissQqKeyboard();
    sleep(CFG.appSwitchWaitMs);
    ensureQqAtBottom();
}

// 从QQ无障碍控件树定位当前聊天输入框。
// 多个编辑框同时出现时选最靠下的一个；不拿其他App的文本框冒充QQ输入框。
function getQqInputBounds() {
    var input = findQqEditable();
    return input ? input.bounds() : null;
}

// 只在QQ聊天底部明确出现“按住说话”时恢复键盘；普通输入不碰左侧切换键。
function findQqVoiceModeButton() {
    var pattern = /^(?:按住\s*(?:说话|讲话|录音)|(?:Hold|Press)\s+to\s+(?:talk|speak))$/i;
    var selectors = [
        packageName(CFG.qqPackage).textMatches(pattern),
        packageName(CFG.qqPackage).descMatches(pattern)
    ];
    for (var k = 0; k < selectors.length; k++) {
        var nodes = selectors[k].find();
        for (var i = nodes.size() - 1; i >= 0; i--) {
            var n = nodes.get(i);
            if (!n || !n.visibleToUser() || !n.enabled()) continue;
            var b = n.bounds();
            if (!b || b.width() <= 0 || b.height() <= 0) continue;
            if (b.top < device.height * 0.75 || b.bottom > device.height) continue;
            if (b.height() > device.height * 0.14) continue;
            if (b.centerX() < device.width * 0.25 || b.centerX() > device.width * 0.75) continue;
            return n;
        }
    }
    return null;
}

function ensureQqTextMode() {
    var pkg = String(currentPackage());
    if (pkg !== CFG.qqPackage && pkg !== "com.huawei.ohos.inputmethod") return false;
    if (findQqEditable()) return true;
    if (pkg !== CFG.qqPackage) return false;

    var voice = findQqVoiceModeButton();
    if (!voice) return false;
    var vb = voice.bounds();
    var pattern = /^(?:(?:切换到|切换为)?(?:键盘|文字)(?:输入)?|切换键盘|Switch to (?:keyboard|text)(?: input)?)$/i;
    var nodes = packageName(CFG.qqPackage).find();
    var target = null;
    var rowTolerance = Math.max(40, Math.round(device.height * 0.035));
    for (var i = 0; i < nodes.size(); i++) {
        var n = nodes.get(i);
        if (!n || !n.visibleToUser() || !n.enabled()) continue;
        if (!pattern.test(String(n.text() || "").trim()) &&
            !pattern.test(String(n.desc() || "").trim())) continue;
        var b = n.bounds();
        if (!b || b.width() <= 0 || b.height() <= 0) continue;
        if (b.width() > device.width * 0.25 || b.height() > device.height * 0.14) continue;
        if (b.centerX() > device.width * 0.25 ||
            Math.abs(b.centerY() - vb.centerY()) > rowTolerance) continue;
        target = b;
        break;
    }

    // 图标没有无障碍名称时，以已经确认的“按住说话”所在行为锚点。
    var x = target ? Math.round(target.centerX()) : Math.round(device.width * 0.08);
    var y = target ? Math.round(target.centerY()) : Math.round(vb.centerY());
    logLine("确认QQ语音输入，点击键盘切换：" + x + "," + y);
    if (!click(x, y)) return false;
    sleep(350);
    return !!findQqEditable();
}

function focusQqTextInput() {
    if (!ensureQqTextMode()) throw new Error("无法确认QQ文字输入框，取消输入");
    var input = findQqEditable();
    if (!input) throw new Error("找不到QQ文字输入框");
    var b = input.bounds();
    var padding = Math.max(6, Math.round(Math.min(b.width(), b.height()) * 0.15));
    // 优先屏幕横向中点；始终限制在文字框内部，远离两侧语音/表情按钮。
    var x = Math.round(Math.max(b.left + padding,
        Math.min(b.right - padding, device.width * 0.50)));
    var y = Math.round(b.centerY());
    logLine("QQ文字框中部点击：" + x + "," + y +
        " bounds=" + [b.left, b.top, b.right, b.bottom].join(","));
    if (!click(x, y)) throw new Error("QQ文字输入框点击失败");
    // 连续两次读到相同位置，才认为键盘动画结束；不复用旧节点。
    input = waitForStableQqInput(CFG.qqInputStableMs);
    if (!input) throw new Error("点击后找不到QQ文字输入框，取消发送");
    return input;
}

function waitForStableQqInput(timeoutMs) {
    var end = Date.now() + timeoutMs, last = "", stable = 0;
    while (running && Date.now() < end) {
        var input = findQqEditable();
        if (input && isQqPageActive()) {
            var b = input.bounds();
            var key = [b.left, b.top, b.right, b.bottom].join(",");
            stable = key === last ? stable + 1 : 0;
            last = key;
            if (stable >= 2) return input;
        } else { last = ""; stable = 0; }
        sleep(180);
    }
    return null;
}

function hasVisibleQqInput() {
    return !!getQqInputBounds();
}

function isQqPageActive() {
    var pkg = String(currentPackage());
    return (pkg === CFG.qqPackage || pkg === "com.huawei.ohos.inputmethod")
        && hasVisibleQqInput();
}

// 只根据当前QQ页面的无障碍文字判断会话类型。
// 需要同时出现输入框和群聊证据才认定为 group；私聊或不确定页面一律不监听。
function dismissQqKeyboard() {
    if (!isQqPageActive()) return false;
    var b = getQqInputBounds();
    if (!b) return false;
    var keyboardVisible = false;
    try {
        keyboardVisible = packageName("com.huawei.ohos.inputmethod")
            .visibleToUser(true).exists();
    } catch (_) {}
    if (!keyboardVisible && b.top > device.height * 0.68) return false;
    logLine("QQ输入框上移或输入法可见，尝试收起键盘");
    back();
    sleep(450);
    return true;
}

function sendQqText(message) {
    var input = null, tapped = false;
    message = String(message || "");
    if (!message || !running) return false;
    try {
        input = focusQqTextInput();
        var existing = String(input.text() || "");
        if (existing && existing !== message) {
            throw new Error("QQ输入框有其他草稿，请先处理后再启动");
        }
        if (input.setText(message) === false) throw new Error("QQ输入内容未确认，写入失败");
        input = waitForStableQqInput(CFG.qqInputStableMs);
        if (!input || String(input.text() || "") !== message) {
            throw new Error("QQ输入内容未确认，取消发送");
        }

        // 只在尚未点击发送时重试。每次重读输入框和发送标签，兼容晚出现的按钮。
        for (var phase = 0; phase < 2 && running && !tapped; phase++) {
            if (phase === 1) {
                dismissQqKeyboard();
                input = waitForStableQqInput(CFG.qqInputStableMs);
                logLine("QQ发送键重定位：已尝试收起键盘");
            }
            var end = Date.now() + CFG.qqSendFindMs / 2;
            while (running && Date.now() < end) {
                input = findQqEditable();
                if (isQqPageActive() && input && String(input.text() || "") === message) {
                    if (clickQqSendButton(input)) { tapped = true; break; }
                }
                sleep(220);
            }
            // 控件标签缺失时只OCR输入框右侧工具栏，不使用固定坐标猜按钮。
            if (!tapped && running) {
                input = findQqEditable();
                if (input && String(input.text() || "") === message) {
                    tapped = clickQqSendByOcr(input, message);
                }
            }
        }
        if (!running) return false;
        if (!tapped) {
            logQqSendDiagnostics("发送前未找到按钮");
            input = findQqEditable();
            if (input && String(input.text() || "") === message) input.setText("");
            dismissQqKeyboard();
            return false;
        }

        // 一旦点击，无论系统返回如何，都不自动再点第二次，防止重复发言。
        var confirmEnd = Date.now() + CFG.qqSendConfirmMs;
        while (running && Date.now() < confirmEnd) {
            input = findQqEditable();
            if (isQqPageActive() && input && !String(input.text() || "").trim()) {
                logLine("QQ发送点击已确认：输入框清空");
                dismissQqKeyboard();
                return true;
            }
            sleep(200);
        }
        if (!running) return false;
        logQqSendDiagnostics("点击后未确认输入框清空");
        throw new Error("QQ发送状态未确认：已点击一次，暂停以避免重复发送，请检查QQ");
    } catch (e) {
        logLine("QQ发送异常：" + e);
        // 未点击前的瞬时定位失败只跳过本轮；未知草稿或已点击的状态必须留给用户确认。
        if (tapped || String(e).indexOf("其他草稿") >= 0) throw e;
        input = findQqEditable();
        if (input && String(input.text() || "") === message) input.setText("");
        return false;
    }
}

function isQqSendLabel(value) {
    return /^(?:发送|发送消息|Send|Sendmessage)(?:[,，]?按钮)?$/i.test(
        String(value || "").replace(/\s+/g, ""));
}

function isQqSendBounds(b, ib) {
    if (!b || !ib || b.width() <= 0 || b.height() <= 0) return false;
    if (b.width() > device.width * 0.30 || b.height() > device.height * 0.14) return false;
    if (b.left < 0 || b.right > device.width || b.top < 0 || b.bottom > device.height) return false;
    if (b.centerX() < device.width * 0.62 || b.centerX() <= ib.centerX()) return false;
    // 多行输入时按钮通常底部对齐，并非输入框垂直中点。
    var margin = Math.max(18, Math.round(device.height * 0.015));
    return b.centerY() >= ib.top - margin && b.centerY() <= ib.bottom + margin;
}

function findQqSendButtonBounds(input) {
    if (!input || !isQqPageActive()) return null;
    var ib = input.bounds();
    var nodes = packageName(CFG.qqPackage).find();
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < nodes.size(); i++) {
        try {
        var n = nodes.get(i);
        if (!n || !n.visibleToUser() || !n.enabled()) continue;
        if (String(n.className()) === "android.widget.EditText") continue;
        if (!isQqSendLabel(n.text()) && !isQqSendLabel(n.desc())) continue;
        var b = n.bounds();
        if (!isQqSendBounds(b, ib)) continue;
        var score = b.centerX() - Math.abs(b.bottom - ib.bottom) * 2;
        if (score > bestScore) { best = b; bestScore = score; }
        } catch (_) { /* QQ重绘时的过期节点，下一轮重读 */ }
    }
    return best;
}

function clickQqSendButton(input) {
    var best = findQqSendButtonBounds(input);
    if (!best || !running) return false;
    logLine("QQ发送标签定位=" + [best.left, best.top, best.right, best.bottom].join(","));
    var result = click(Math.round(best.centerX()), Math.round(best.centerY()));
    logLine("QQ发送点击返回=" + result + "，等待输入框清空确认，不重复点击");
    return true; // 表示已尝试点击；不能把系统返回false当作可以重复发送的证据。
}

function clickQqSendByOcr(input, message) {
    if (!running || !input || !isQqPageActive()) return false;
    var img = null, clip = null;
    try {
        var ib = input.bounds();
        img = captureScreen();
        var sx = img.getWidth() / device.width, sy = img.getHeight() / device.height;
        var left = Math.round(Math.max(ib.right - 8, device.width * 0.70) * sx);
        var top = Math.round(Math.max(0, ib.top - 8) * sy);
        var bottom = Math.min(img.getHeight(), Math.round((ib.bottom + 18) * sy));
        if (img.getWidth() - left < 20 || bottom - top < 20) return false;
        clip = images.clip(img, left, top, img.getWidth() - left, bottom - top);
        var items = normalizeOcrDetailed(ocr.detect(clip), {left:left, top:top}, true);
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!isQqSendLabel(item.text)) continue;
            var b = new android.graphics.Rect(Math.round(item.x / sx), Math.round(item.y / sy),
                Math.round(item.right / sx), Math.round(item.bottom / sy));
            var fresh = findQqEditable();
            if (!fresh || !isQqPageActive() || String(fresh.text() || "") !== message) return false;
            var fb = fresh.bounds();
            if (Math.abs(fb.top - ib.top) > 8 || Math.abs(fb.bottom - ib.bottom) > 8) return false;
            if (isQqSendBounds(b, fb) && running) {
                logLine("QQ发送标签通过工具栏OCR定位");
                var result = click(Math.round(b.centerX()), Math.round(b.centerY()));
                logLine("QQ OCR发送点击返回=" + result + "，等待输入框清空确认");
                return true;
            }
        }
    } catch (e) { logLine("QQ发送按钮OCR兜底失败：" + e); }
    finally {
        if (clip) { try { clip.recycle(); } catch (_) {} }
        if (img) { try { img.recycle(); } catch (_) {} }
    }
    return false;
}

function logQqSendDiagnostics(reason) {
    var input = findQqEditable(), detail = [];
    try {
        var nodes = packageName(CFG.qqPackage).find();
        for (var i = 0; i < nodes.size() && detail.length < 16; i++) {
            var n = nodes.get(i), b = n.bounds();
            if (!n.visibleToUser() || !b || b.centerX() < device.width * 0.6) continue;
            if (input && b.bottom < input.bounds().top - 25) continue;
            var label = String(n.text() || n.desc() || "");
            if (/发送|send|语音|表情|加号/i.test(label)) {
                detail.push(label.slice(0, 24) + "@" + [b.left,b.top,b.right,b.bottom].join(","));
            }
        }
    } catch (_) {}
    logLine(reason + " 前台=" + currentPackage() + " 右侧控件=" + detail.join(" | "));
}

// 后备方案：兼容只有箭头图标、没有“发送”文字的按钮。
// 先按文字/无障碍描述查找；失败后，在输入框右侧及其下方的输入面板内寻找可点击控件。
function clickSendButton(input, pattern, fixedFallback) {
    if (clickNamedButton(pattern)) return true;
    if (!input) return false;

    var ib = input.bounds();
    var inputPkg = String(input.packageName() || "");
    var screenW = device.width;
    var screenH = device.height;
    var nodes = classNameMatches(/.*/).find();
    var best = null;
    var bestScore = -Infinity;

    for (var i = 0; i < nodes.size(); i++) {
        var n = nodes.get(i);
        if (!n || !n.visibleToUser() || !n.enabled() || !n.clickable()) continue;
        // Compose 子控件有时不返回包名；键盘弹出后 currentPackage() 也可能不可靠。
        var nodePkg = String(n.packageName() || "");
        // 输入法弹出时，华为无障碍树可能把同一页面的发送箭头标成输入法包名；
        // 不再因为包名不一致直接过滤，后续位置和大小条件仍会限制误点。

        var b = n.bounds();
        if (!b || b.width() <= 0 || b.height() <= 0) continue;
        if (b.width() > screenW * 0.35 || b.height() > screenH * 0.20) continue;

        // ChatGPT 的箭头位于文字编辑区域下方，所以允许向下扩展一个输入工具栏高度。
        var maxDown = Math.max(180, Math.min(320, ib.height() * 0.55));
        if (b.centerY() < ib.top - 60 || b.centerY() > ib.bottom + maxDown) continue;
        if (b.centerX() <= ib.centerX() || b.centerX() < screenW * 0.62) continue;

        var targetY = Math.min(screenH, ib.bottom + 55);
        var yDistance = Math.abs(b.centerY() - targetY);
        var areaPenalty = b.width() * b.height() * 0.001;
        var score = b.centerX() * 2 - yDistance - areaPenalty;
        if (score > bestScore) {
            best = n;
            bestScore = score;
        }
    }

    if (best && best.click()) return true;

    // P50e 专用兜底：控件树完全不暴露发送箭头时，按当前屏幕比例点击。
    // 比例取自 696×1536 截图中的发送键中心 (623, 945)，可适配同纵横比的系统缩放。
    if (fixedFallback && inputPkg === CFG.chatgptPackage && String(input.text() || "").trim()) {
        var x = Math.round(device.width * fixedFallback.xRatio);
        var y = Math.round(device.height * fixedFallback.yRatio);
        logLine("控件识别失败，使用P50e固定比例发送点：" + x + "," + y);
        return click(x, y);
    }
    return false;
}

function clickNamedButton(pattern) {
    var selectors = [textMatches(pattern), descMatches(pattern)];
    for (var i = 0; i < selectors.length; i++) {
        var nodes = selectors[i].find();
        for (var j = nodes.size() - 1; j >= 0; j--) {
            var n = nodes.get(j);
            if (!n || !n.visibleToUser() || !n.enabled()) continue;
            if (n.click()) return true;
            var p = n.parent();
            if (p && p.clickable() && p.click()) return true;
        }
    }
    return false;
}

// v0.4.2：实测ChatGPT发送键desc为“发送消息”，但clickable=false。
// 锁定该节点后读取实时bounds，优先逐级点击父容器，最后点击节点中心。
function clickChatGptSend() {
    var nodes;
    try {
        nodes = packageName(CFG.chatgptPackage).desc("发送消息").find();
    } catch (_) {
        return false;
    }
    for (var i = nodes.size() - 1; i >= 0; i--) {
        var n = nodes.get(i);
        if (!n || !n.visibleToUser() || !n.enabled()) continue;

        var p = n;
        for (var depth = 0; p && depth < 8; depth++) {
            if (p.clickable() && p.enabled() && p.click()) return true;
            p = p.parent();
        }

        var b = n.bounds();
        if (b && b.width() > 0 && b.height() > 0 && click(b.centerX(), b.centerY())) {
            logLine("已按发送消息节点中心点击：" + b.centerX() + "," + b.centerY());
            return true;
        }
    }
    return false;
}

// 只允许通过明确的“回到底部/新消息/未读消息”按钮回到最新位置。
// 不执行任何 swipe 或坐标滑动；找不到明确按钮就保持当前页面不动。
function ensureQqAtBottom() {
    if (!isQqPageActive()) return false;
    var pattern = /^(回到底部|返回底部|跳到最新|查看最新消息|\d+条新消息|\d+条未读消息)$/;
    var clicked = false;
    try {
        var selectors = [textMatches(pattern), descMatches(pattern)];
        for (var k = 0; k < selectors.length && !clicked; k++) {
            var ns = selectors[k].find();
            for (var i = 0; i < ns.size(); i++) {
                var n = ns.get(i);
                if (!n || !n.visibleToUser()) continue;
                var p = n;
                for (var d = 0; p && d < 3; d++, p = p.parent()) {
                    if (p.clickable() && p.click()) { clicked = true; break; }
                }
            }
        }
    } catch (e) {
        logLine("定位聊天底部按钮失败：" + e);
    }
    if (clicked) sleep(280);
    return clicked;
}

// OCR 只裁剪输入框上方区域；旧的80.5%固定限制会漏掉最下方新消息，已移除。
function getQqOcrRegion(imgW, imgH) {
    var b = getQqInputBounds();
    if (!b) return null;
    var scale = imgH / Math.max(1, device.height);
    var top = Math.floor(imgH * CFG.chatTopRatio);
    var inputTop = Math.floor(b.top * scale);
    var margin = Math.max(8, Math.round(CFG.chatInputGapPx * scale));
    var bottom = Math.min(Math.floor(imgH * 0.975), inputTop - margin);
    if (bottom - top < imgH * CFG.minChatAreaRatio) return null;
    return { left: 0, top: top, width: imgW, height: bottom - top,
             bottom: bottom, inputTop: inputTop };
}


// 本地判断“聊天内容是否真的变化”用的规范化。
// 只用于决定要不要请求GPT，不会改变发给GPT看的OCR原文。
function normalizeChatFingerprintText(raw) {
    var s = String(raw || "")
        .replace(/\u00A0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/[，,。．]/g, "")
        .replace(/[：:]/g, ":")
        .replace(/[（）()【】\[\]「」『』]/g, "")
        .trim()
        .toLowerCase();

    // 去掉脚本自动附加的版本号，避免版本文字影响本地变化判断。
    s = s.replace(/\s*v\d+(?:\.\d+){1,2}\s*$/i, "").trim();
    return s;
}

// 过滤明显属于QQ界面/时间的瞬时文字。
// 不过滤普通短消息和纯数字消息，避免漏掉群友真实发言。
function isTransientQqLine(raw) {
    var s = String(raw || "").trim();
    if (!s) return true;

    // 常见时间：10:28、上午10:28、下午 3:05、昨天 10:28 等。
    if (/^(?:今天|昨天|前天)?\s*(?:上午|下午|晚上|凌晨|中午)?\s*\d{1,2}:\d{2}$/.test(s)) return true;

    // 常见QQ聊天界面提示，不作为“聊天内容变化”。
    if (/^(?:回到底部|返回底部|跳到最新|查看最新消息|\d+条新消息|\d+条未读消息|发送|图片|相机|语音|表情|加号|返回)$/.test(s)) return true;

    // 顶部群待办/系统栏这类持续存在但会偶尔刷新。
    if (/^(?:回群待办|群待办|本群新法案)/.test(s)) return true;

    return false;
}

// 忽略机器人自己刚刚发出的内容，避免“自己发一句 -> 又触发一次GPT请求”。
// 对较长文本允许OCR分段后的包含匹配；过短文本不做模糊忽略，防止误伤群友。
function isOwnRecentBotLine(raw) {
    var line = normalizeChatFingerprintText(raw);
    var own = normalizeChatFingerprintText(state.lastBotText || "");
    if (!line || !own) return false;
    if (line === own) return true;
    if (line.length >= 6 && own.length >= 6 &&
        (own.indexOf(line) >= 0 || line.indexOf(own) >= 0)) return true;
    return false;
}

function buildLocalChatFingerprint(lines) {
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
        var raw = String(lines[i] || "").trim();
        if (!raw || isTransientQqLine(raw) || isOwnRecentBotLine(raw)) continue;
        var s = normalizeChatFingerprintText(raw);
        if (!s) continue;
        kept.push(s);
    }

    // 只取屏幕底部最近内容，降低顶部昵称/公告轻微抖动造成的误触发。
    kept = kept.slice(-18);
    return {
        lines: kept,
        signature: hashString(kept.join("\n"))
    };
}

// 不依赖QQ是否把聊天图片暴露成ImageView。
// 直接对聊天区靠下部分做低分辨率像素扫描，寻找“尺寸足够大、内部颜色/明暗变化连续”的视觉块。
// 这更适合QQ自绘图片、截图、梗图和静态表情。
function containsEmojiText(value) {
    var s = String(value || "");
    for (var i = 0; i < s.length; i++) {
        var cp = s.charCodeAt(i);
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
            var low = s.charCodeAt(i + 1);
            if (low >= 0xDC00 && low <= 0xDFFF) {
                cp = 0x10000 + (cp - 0xD800) * 1024 + low - 0xDC00;
                i++;
            }
        }
        if ((cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF) ||
            cp === 0x20E3 || cp === 0x231A || cp === 0x231B ||
            (cp >= 0x23E9 && cp <= 0x23F3)) return true;
    }
    return /\[(?:微笑|撇嘴|色|发呆|得意|流泪|害羞|闭嘴|睡|大哭|尴尬|发怒|调皮|呲牙|惊讶|难过|酷|冷汗|抓狂|吐|偷笑|可爱|白眼|傲慢|饥饿|困|惊恐|流汗|憨笑|大兵|奋斗|咒骂|疑问|嘘|晕|折磨|衰|骷髅|敲打|再见|擦汗|抠鼻|鼓掌|糗大了|坏笑|左哼哼|右哼哼|哈欠|鄙视|委屈|快哭了|阴险|亲亲|吓|可怜|拥抱|强|弱|握手|胜利|抱拳|勾引|拳头|差劲|爱你|NO|OK|捂脸|笑哭|旺柴|破涕为笑|机智|吃瓜|doge)\]/i.test(s);
}

function readQqEmojiItems(region) {
    var out = [], seen = {};
    if (!region || !isQqPageActive()) return out;
    var nodes = packageName(CFG.qqPackage).find();
    var scaleX = region.width / device.width;
    var scaleY = region.scaleY || scaleX;
    for (var i = 0; i < nodes.size(); i++) {
        try {
            var n = nodes.get(i);
            if (!n || !n.visibleToUser() || String(n.className()) === "android.widget.EditText") continue;
            var b = n.bounds();
            if (!b || b.width() < 8 || b.height() < 8 || b.height() > device.height * 0.18) continue;
            if (b.centerX() < device.width * 0.14 || b.centerX() > device.width * 0.86) continue;
            if (b.top * scaleY < region.top || b.bottom * scaleY > region.bottom) continue;
            var nativeText = String(n.text() || "").trim();
            var nativeDesc = String(n.desc() || "").trim();
            var value = containsEmojiText(nativeText) ? nativeText :
                (containsEmojiText(nativeDesc) ? nativeDesc : "");
            if (!value || value.length > 500) continue;
            var key = [b.left,b.top,b.right,b.bottom,value].join("|");
            if (seen[key]) continue;
            seen[key] = true;
            out.push({text:value, x:b.left * scaleX, y:b.top * scaleY,
                right:b.right * scaleX, bottom:b.bottom * scaleY, source:"accessibility"});
        } catch (_) {}
    }
    // 部分QQ父节点和子节点会暴露同一文本。优先保留面积较小的真实消息节点。
    out.sort(function (a,b) {
        return (a.right-a.x)*(a.bottom-a.y) - (b.right-b.x)*(b.bottom-b.y);
    });
    var unique = [];
    for (var j = 0; j < out.length; j++) {
        var duplicate = false;
        for (var k = 0; k < unique.length; k++) {
            var a = out[j], u = unique[k];
            if (a.text === u.text && a.x <= u.x && a.y <= u.y &&
                a.right >= u.right && a.bottom >= u.bottom) { duplicate = true; break; }
        }
        if (!duplicate) unique.push(out[j]);
    }
    unique.sort(function(a,b) { return Math.abs(a.y-b.y)>8 ? a.y-b.y : a.x-b.x; });
    return unique.slice(-12);
}

function mergeQqEmojiItems(ocrItems, nativeItems) {
    var items = ocrItems.slice();
    for (var i = 0; i < nativeItems.length; i++) {
        var n = nativeItems[i], duplicate = false, kept = [];
        for (var j = 0; j < items.length; j++) {
            var o = items[j];
            var sameRow = Math.abs((o.y + o.bottom) / 2 - (n.y + n.bottom) / 2) <=
                Math.max(12, (n.bottom - n.y) * 0.65);
            var inside = o.x >= n.x - 8 && o.right <= n.right + 8 &&
                o.y >= n.y - 8 && o.bottom <= n.bottom + 8;
            if (sameRow && inside && o.text === n.text) duplicate = true;
            // 仅替换其自身范围内的OCR；不会把相邻昵称或另一条消息一起删掉。
            if (inside && !duplicate) continue;
            kept.push(o);
        }
        if (!duplicate) kept.push(n);
        items = kept;
    }
    items.sort(function(a,b) { return Math.abs(a.y-b.y)>8 ? a.y-b.y : a.x-b.x; });
    return items.slice(-Math.max(CFG.maxOcrLines * 2, 50));
}

function readQqScreen() {
    if (!isQqPageActive()) return {valid:false,lines:[],signature:"",chatSignature:""};
    var img = captureScreen();
    if (!img) throw new Error("截图失败");
    var clip = null;
    try {
        var region = getQqOcrRegion(img.getWidth(), img.getHeight());
        if (!region) return {valid:false,lines:[],signature:"",chatSignature:""};
        clip = images.clip(img, region.left, region.top, region.width, region.height);
        ocr.mode = "mlkit";
        var ocrItems = normalizeOcrDetailed(ocr.detect(clip), region);
        // 保留 QQ 无障碍树能直接提供的 emoji 文本；不做任何图片像素识别或截图附件。
        ocrItems = mergeQqEmojiItems(ocrItems, readQqEmojiItems(region));
        var lines = ocrItems.map(function(x) { return x.text; }).slice(-CFG.maxOcrLines);
        if (!lines.length) return {valid:false,lines:[],signature:"",chatSignature:"",region:region};
        var local = buildLocalChatFingerprint(lines);
        return {valid:true, lines:lines,
            signature:hashString(lines.join("\n")), chatSignature:local.signature,
            chatFingerprintLines:local.lines, ocrItems:ocrItems, region:region};
    } finally {
        if (clip) { try { clip.recycle(); } catch (_) {} }
        try { img.recycle(); } catch (_) {}
    }
}

function normalizeOcrDetailed(raw, region, keepUiLabels) {
    if (!raw) return [];
    var arr = Array.isArray(raw) ? raw : (raw.results || raw.data || []);
    var out = [];
    var offsetX = region ? Number(region.left || 0) : 0;
    var offsetY = region ? Number(region.top || 0) : 0;

    for (var i = 0; i < arr.length; i++) {
        var x = arr[i] || {};
        var t = String(x.text || x.label || x.words || x.value || "")
            .trim()
            .replace(/\s+/g, " ");
        if (!t || (!keepUiLabels && /^(发送|图片|相机|语音|表情|加号|返回)$/.test(t))) continue;

        var b = x.bounds || x.rect || x.boundingBox || {};
        var top = Number(b.top != null ? b.top : (Array.isArray(b) ? b[1] : i * 10));
        var left = Number(b.left != null ? b.left : (Array.isArray(b) ? b[0] : 0));
        var right = Number(b.right != null ? b.right :
            (Array.isArray(b) && b.length > 2 ? b[2] : left));
        var bottom = Number(b.bottom != null ? b.bottom :
            (Array.isArray(b) && b.length > 3 ? b[3] : top));

        if (isNaN(top)) top = i * 10;
        if (isNaN(left)) left = 0;
        if (isNaN(right)) right = left;
        if (isNaN(bottom)) bottom = top;

        out.push({
            text: t,
            y: top + offsetY,
            x: left + offsetX,
            right: right + offsetX,
            bottom: bottom + offsetY
        });
    }

    out.sort(function (a, b) {
        return Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x;
    });

    return out.slice(-Math.max(CFG.maxOcrLines * 2, 50));
}

// 兼容旧调用；新逻辑优先使用normalizeOcrDetailed保留坐标。
function normalizeOcr(raw) {
    return normalizeOcrDetailed(raw, null)
        .map(function (x) { return x.text; })
        .slice(-CFG.maxOcrLines);
}

function ensureOcrReady() {
    try {
        if (!ocr || typeof ocr.detect !== "function") throw 0;
        ocr.mode = "mlkit";
    } catch (_) {
        throw new Error("AutoJs6 内置 ML Kit OCR 不可用，请确认使用 AutoJs6 6.7.0 后重启应用");
    }
}

function testOcr() {
    try {
        if (!getCapturePermission()) throw new Error("没有截图权限");
        ensureOcrReady();
        app.launchPackage(CFG.qqPackage);
        waitForPackage(CFG.qqPackage, 12000);
        sleep(CFG.appSwitchWaitMs);
        ensureQqAtBottom();
        var shot = readQqScreen();
        var range = shot.region ? ("当前聊天：" + activeChatKey + "；识别区域：Y=" + shot.region.top + "～" + shot.region.bottom + "；输入框顶部Y=" + shot.region.inputTop + "\n\n") : "无法定位QQ聊天输入框，本次未进行OCR。请打开目标聊天。\n\n";
        var coordPreview = "";
        if (shot.ocrItems && shot.ocrItems.length) {
            coordPreview = "\n\n--- OCR坐标（底部最近12项）---\n" +
                shot.ocrItems.slice(-12).map(function (x) {
                    return "[" + Math.round(x.x) + "," + Math.round(x.y) + "] " + x.text;
                }).join("\n");
        }
        dialogs.alert("OCR 测试结果",
            range + (shot.lines.length ? shot.lines.join("\n") : "没有识别到聊天文字") + coordPreview);
    } catch (e) { dialogs.alert("OCR 测试失败", String(e)); }
}

function findQqEditable() {
    try {
        var nodes = packageName(CFG.qqPackage)
            .className("android.widget.EditText").visibleToUser(true).find();
        var chosen = null, chosenBounds = null;
        for (var i = 0; i < nodes.size(); i++) {
            var n = nodes.get(i);
            if (!n || !n.enabled() || !n.visibleToUser()) continue;
            var b = n.bounds();
            if (!b || b.width() < device.width * 0.22 || b.height() < 15) continue;
            if (b.left < 0 || b.right > device.width || b.bottom > device.height) continue;
            if (b.top <= device.height * 0.27 || b.top > device.height * 0.95) continue;
            if (!chosen || b.bottom > chosenBounds.bottom ||
                (b.bottom === chosenBounds.bottom && b.width() > chosenBounds.width())) {
                chosen = n;
                chosenBounds = b;
            }
        }
        return chosen;
    } catch (_) {}
    return null;
}

function findEditable() {
    var nodes = className("android.widget.EditText").find();
    for (var i = nodes.size() - 1; i >= 0; i--) {
        var n = nodes.get(i);
        if (n && n.visibleToUser() && n.enabled()) return n;
    }
    return null;
}

function collectVisibleValues() {
    var values = [], nodes = classNameMatches(/.*/).find();
    for (var i = 0; i < nodes.size(); i++) {
        var n = nodes.get(i);
        if (!n || !n.visibleToUser()) continue;
        var s = String(n.text() || n.desc() || "").trim();
        if (s) values.push(s);
    }
    return values;
}

function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
}

function logLine(s) {
    try {
        files.ensureDir(CFG.logFile);
        files.append(CFG.logFile, new Date().toLocaleString() + "  " + s + "\n");
    } catch (_) {}
}
