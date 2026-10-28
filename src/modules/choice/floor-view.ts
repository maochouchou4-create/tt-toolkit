/**
 * choice 楼层渲染器：把每条有存档的 AI 楼层自己的选项块画进该楼
 * `.mes_block` 尾部（正文流内，非浮层）。
 *
 * 为什么是纯 DOM＋观察器：宿主整段重印 .mes（redisplayChat/printMessages）
 * 会把 Vue Teleport 的目标节点连根换掉且不自动重定向（vue 3.5 只在 dev
 * 打一条 warn，prod 无痕），仍是「外挂观察器补挂」的账，零件反而更多。
 * 这里展示面只有数据→节点的单向映射：观察器覆盖宿主全部已知 DOM 路径
 * （重印/虚拟化装卸/截断补挂/编辑替换 mes_text），store $subscribe 覆盖
 * 生成路径（写档不写 DOM），安装即首帧对账覆盖「扩展晚于首屏」。
 *
 * 数据真相源＝楼层存档（persist.ts）；本渲染器不存展示副本，每次对账
 * 现读。选项文本是模型输出（不可信输入）：一律 createElement+textContent，
 * 禁 innerHTML（check-imports 机判）。
 */
import { getChatMessages, HOST_DOM, showToast, waitForResource } from '@/host';
import { createTtlog } from '@/host/ttlog';
import { choiceStorage } from './api';
import { applyOption } from './generator';
import { isAiFloor, readFloorOptions, type StoredFloorOptions } from './persist';
import { useChoiceStore, type GeneratePhase } from './store';
import { useChoiceSettingsStore } from './settings';
import './choice-bar.css';

const ttlog = createTtlog('choice');

const FLOOR_CLASS = 'tt-choice-floor';

// 幂等旗标走窗口级（nav 先例）：扩展重载会重新求值模块，模块级旗标归零
// 而旧 observer/点击委托仍挂着——双份委托＝append 加倍、send 双发。
const FLOOR_VIEW_FLAG = '__TT_CHOICE_FLOOR_VIEW__';

// #chat 是宿主静态骨架，但扩展加载顺序不受本模块控制：与 nav QR、shell
// 魔棒同一条 10s 最坏情况等待预算（两处先例都是 250×40），间隔放宽到
// 500——静态骨架不是高频目标，减少无谓轮询唤醒。
const CHAT_WAIT_INTERVAL_MS = 500;
const CHAT_WAIT_MAX_TRIES = 20;

/** 缺 .mes_block 的聚合提示每会话只报一次（用户打不开 devtools，必须 toast）。 */
let blockMissReported = false;

/** floor 选择器全灭的提示每会话只报一次（同上，聚合去重）。 */
let floorMissReported = false;

/** rAF 合并：一轮 DOM 变更/状态变更只对账一次。 */
let scheduledFrame: number | null = null;

function schedule(): void {
    if (scheduledFrame !== null) return;
    scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = null;
        reconcile();
    });
}

/** 点击行为对应的悬停提示（与点击应用同读一份设置）。 */
function behaviorHint(): string {
    const behavior = choiceStorage.readDomain().gen.clickBehavior;
    if (behavior === 'send') return '点击后直接发送';
    if (behavior === 'append') return '点击后追加到输入框末尾';
    return '点击后填入输入框（可编辑后手动发送）';
}

function textSpan(className: string, text: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
}

interface BlockInput {
    floorIndex: number;
    stored: StoredFloorOptions | null;
    isAnchor: boolean;
    /** 非锚楼不画相位/错误面，归一 null：生成起止不得触发无关楼重建。 */
    phase: GeneratePhase | null;
    error: string;
    hint: string;
}

/** 画一块：锚楼＝错误行→选项网格→「正在生成…」行；非锚楼只有选项网格。 */
function buildFloorBlock(input: BlockInput): HTMLElement {
    const container = document.createElement('div');
    container.className = FLOOR_CLASS;
    container.dataset.floor = String(input.floorIndex);
    const options = input.stored?.options ?? [];

    if (input.isAnchor && input.phase === 'error' && input.error !== '') {
        const errorRow = document.createElement('div');
        errorRow.className = 'tt-choice-error';
        errorRow.title = input.error;
        errorRow.textContent = input.error;
        container.appendChild(errorRow);
    }

    if (options.length > 0) {
        const grid = document.createElement('div');
        grid.className = 'tt-choice-grid';
        options.forEach((option, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tt-choice-option';
            button.title = input.hint;
            button.dataset.floor = String(input.floorIndex);
            button.dataset.idx = String(index);
            if (option.title) button.appendChild(textSpan('tt-choice-option-title', option.title));
            button.appendChild(textSpan('tt-choice-option-content', option.content));
            if (option.aim) button.appendChild(textSpan('tt-choice-option-aim', option.aim));
            grid.appendChild(button);
        });
        container.appendChild(grid);
    }

    if (input.isAnchor && input.phase === 'running' && options.length === 0) {
        const pending = document.createElement('div');
        pending.className = 'tt-choice-pending';
        pending.textContent = '正在生成…';
        container.appendChild(pending);
    }

    return container;
}

/** 单楼渲染缓存：只存上次渲染签名（内容派生，构造见 reconcile 内说明）。 */
interface FloorCacheEntry {
    /** 上次渲染的完整输入签名（存档内容＋除存档外的全部渲染输入） */
    renderedSig: string;
}

const floorCache = new Map<number, FloorCacheEntry>();

/**
 * 全量对账（幂等）：按当前 DOM 楼层集合逐楼决定块的存在与重建。
 * 块存在＝该楼有非空存档且非 user 楼，或该楼是生成锚楼且相位为运行/失败；
 * 条件不满足即显式移除容器（删楼/清档/锚楼漂移都不留残块）。
 */
function reconcile(): void {
    const root = document.querySelector(HOST_DOM.chatRoot);
    if (root === null) return;
    const store = useChoiceStore();
    const messages = getChatMessages();
    const anchorIndex = store.anchorFloorIndex;
    const anchorMessage = store.anchorMessage;
    const hint = behaviorHint();
    let missingBlocks = 0;

    const floors = root.querySelectorAll(HOST_DOM.floor);
    for (const floorEl of floors) {
        if (!(floorEl instanceof HTMLElement)) continue;
        // 宿主有「先插节点、后写 mesid」的窗口（observer 已盯 attributeFilter
        // mesid）：空串经 Number() 恰好落成 0 楼，把 0 楼的档画到无主节点上
        const rawMesid = floorEl.getAttribute('mesid');
        if (rawMesid === null || rawMesid.trim() === '') continue;
        const floorIndex = Number(rawMesid);
        if (!Number.isInteger(floorIndex) || floorIndex < 0) continue;

        const message = messages[floorIndex];
        const stored = readFloorOptions(floorIndex);
        // 身份校验：索引对且消息对象仍是生成起点那条——生成中新楼到达、
        // 删楼左移、切聊天都不能把状态行画到别楼
        const isAnchor = floorIndex === anchorIndex
            && message !== undefined
            && message === anchorMessage
            && (store.phase === 'running' || store.phase === 'error');
        const hasOptions = stored !== null
            && stored.options.length > 0
            && message !== undefined
            && isAiFloor(message);

        const block = floorEl.querySelector<HTMLElement>(`:scope > ${HOST_DOM.floorBlock}`);
        const existing = block?.querySelector<HTMLElement>(`:scope > .${FLOOR_CLASS}`) ?? null;

        if (!hasOptions && !isAnchor) {
            existing?.remove();
            floorCache.delete(floorIndex);
            continue;
        }
        if (block === null) {
            missingBlocks += 1;
            continue;
        }

        const previous = floorCache.get(floorIndex);
        // 渲染输入单对象（phase/error 非锚楼归一）——签名与构建同源派生：
        // {...input, stored: undefined} 序列化时丢弃 stored 字段，等价于
        // 「存档外的全部渲染输入」；新增渲染输入自动进签名，无手抄清单
        const input: BlockInput = {
            floorIndex,
            stored,
            isAnchor,
            phase: isAnchor ? store.phase : null,
            error: isAnchor ? store.error : '',
            hint,
        };
        const sig = `${JSON.stringify(stored?.options ?? [])}|${stored?.dropped ?? ''}`
            + `|${JSON.stringify({ ...input, stored: undefined })}`;
        if (existing !== null && previous !== undefined && previous.renderedSig === sig) {
            continue;
        }

        const container = buildFloorBlock(input);
        if (existing !== null) existing.replaceWith(container);
        else block.appendChild(container);
        floorCache.set(floorIndex, { renderedSig: sig });
    }

    if (missingBlocks > 0 && !blockMissReported) {
        blockMissReported = true;
        ttlog.warn(`floor view: ${missingBlocks} floor(s) missing ${HOST_DOM.floorBlock}, choice block not mounted`);
        showToast(`选项块未挂载：${missingBlocks} 条楼层找不到 ${HOST_DOM.floorBlock}（宿主模板可能已变更）`, 'warning');
    }

    // floor 选择器全灭守卫：root 有子节点却匹配不到任何楼层＝选择器漂移
    // （宿主改属性名等）。此时上面的循环零次、missingBlocks 恒 0，属全
    // 功能静默死亡——chatRoot/floorBlock 有静态锚门，floor 无静态片段可
    // 锚（mesid 宿主脚本写入），运行期显式出口是它的唯一守门。
    if (floors.length === 0 && root.children.length > 0 && !floorMissReported) {
        floorMissReported = true;
        ttlog.warn(`floor view: ${HOST_DOM.floor} matched 0 floors under ${HOST_DOM.chatRoot} (host DOM changed?)`);
        showToast(`选项楼层渲染失效：楼层选择器 ${HOST_DOM.floor} 未匹配到任何楼层（宿主可能已变更）`, 'error');
    }
}

/**
 * 点击委托（#chat 上一次性）：点击现场读档，不用渲染期快照——块可能是
 * 旧签名的残留，存档才是真值；null/越界拒点。只把 content 交给点击行为，
 * aim 属展示与存档面，绝不外发（主聊天出现「想撬动什么」＝对外契约破坏）。
 */
function onOptionClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('.tt-choice-option');
    if (button === null) return;
    const floorIndex = Number(button.dataset.floor);
    const optionIndex = Number(button.dataset.idx);
    if (!Number.isInteger(floorIndex) || !Number.isInteger(optionIndex)) return;
    const stored = readFloorOptions(floorIndex);
    if (stored === null || optionIndex < 0 || optionIndex >= stored.options.length) return;
    applyOption(stored.options[optionIndex].content);
}

/**
 * 安装楼层渲染（幂等）。#chat 是宿主静态骨架，但扩展可能早于聊天区就绪
 * （加载流程变更）——走 host 三段等待；超时＝放弃并 toast（fail fast，
 * 不静默留一个永远不渲染的扩展）。
 */
export function installFloorView(): void {
    const flagWindow = globalThis as Record<string, unknown>;
    if (flagWindow[FLOOR_VIEW_FLAG]) return;
    flagWindow[FLOOR_VIEW_FLAG] = true;
    void (async (): Promise<void> => {
        const root = await waitForResource(() => document.querySelector<HTMLElement>(HOST_DOM.chatRoot), {
            intervalMs: CHAT_WAIT_INTERVAL_MS,
            maxTries: CHAT_WAIT_MAX_TRIES,
        });
        if (root === null) {
            ttlog.warn(`floor view skipped: ${HOST_DOM.chatRoot} missing after wait`);
            showToast(`选项楼层渲染未启动：等待 ${HOST_DOM.chatRoot} 超时`, 'error');
            return;
        }
        // 观察口径对齐宿主自己的 chat-dom-adapter（childList+subtree＋
        // mesid 属性）：整段重印、虚拟化装卸、截断补挂、swipe 重写都在内
        const observer = new MutationObserver(() => schedule());
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid'] });
        // 生成路径写档不写 DOM：store 状态变更同样触发对账
        useChoiceStore().$subscribe(() => schedule());
        // 设置域写穿（revision++）也是渲染输入：点击行为提示进签名，改
        // 设置即改块——没有这条订阅，提示要等下一次无关 DOM 变化才跟上
        useChoiceSettingsStore().$subscribe(() => schedule());
        root.addEventListener('click', onOptionClick);
        // 安装末位无条件对账一次：扩展晚于首屏渲染（重载/热激活）时首帧即正确
        schedule();
        ttlog.info('floor view installed');
    })();
}
