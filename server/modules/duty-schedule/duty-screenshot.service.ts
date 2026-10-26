import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import FormData from 'form-data';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { chromium, type ElementHandle, type Page } from 'playwright-core';
import {
  getFeishuAuthPayload,
  readEnv,
} from '@server/common/config/external-services.config';
import {
  DutyDailyReportBitableService,
  type DutyDailyReportScreenshotResult,
  type DutyDailyReportShift,
} from '@server/modules/duty-schedule/duty-daily-report-bitable.service';
import {
  createCampusOperationsScreenshotAccessToken,
  createMonthlyScheduleScreenshotAccessToken,
} from '@server/modules/duty-schedule/monthly-schedule-screenshot-access';
import {
  DEFAULT_TYPHOON_PATH_CHAT_ID,
  TYPHOON_PATH_URL,
} from '@server/modules/duty-schedule/typhoon-warning-alert';
import { resolveDutyDailyReportStateFilePath } from '@server/modules/duty-schedule/duty-daily-report-state-path';

type DutyOverviewScreenshotSource = 'manual' | 'auto-08:50' | 'auto-17:50';
type TyphoonPathScreenshotSource =
  | 'manual-test'
  | 'manual-group'
  | 'auto-typhoon-warning';
type DutyScreenshotSource = DutyOverviewScreenshotSource | TyphoonPathScreenshotSource;
type DutyScreenshotKind = 'duty-overview' | 'campus-operations-dashboard' | 'typhoon-path';
type FeishuReceiveIdType = 'chat_id' | 'user_id' | 'open_id' | 'email';

interface FeishuMessageReceiver {
  id: string;
  type: FeishuReceiveIdType;
}

type DutyScreenshotDeliveryKind = 'card' | 'image';

interface CompletedDutyScreenshotDelivery {
  completedAt: string;
  messageId?: string;
}

interface DutyScreenshotDeliveryState {
  version: 1;
  completed: Record<string, CompletedDutyScreenshotDelivery>;
}

export interface DutyOverviewScreenshotOptions {
  source?: DutyOverviewScreenshotSource;
  date?: string;
}

export interface DutyOverviewScreenshotResult {
  success: boolean;
  source: DutyOverviewScreenshotSource;
  message: string;
  screenshotDate: string;
  sentAt: string;
  chatId: string;
  chatIds: string[];
  imageKey?: string;
  screenshotPath?: string;
  dailyReport?: DutyDailyReportScreenshotResult;
  campusOperationsScreenshotPath?: string;
  campusOperationsDailyReport?: DutyDailyReportScreenshotResult;
}

export interface TyphoonPathScreenshotOptions {
  source?: TyphoonPathScreenshotSource;
  chatId?: string;
  receiveId?: string;
  receiveIdType?: FeishuReceiveIdType;
  warningTitle?: string;
  warningLevel?: string;
  deliveryKey?: string;
}

export interface TyphoonPathScreenshotResult {
  success: boolean;
  source: TyphoonPathScreenshotSource;
  message: string;
  sentAt: string;
  chatId: string;
  chatIds: string[];
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  imageKey?: string;
  screenshotPath?: string;
  warningTitle?: string;
  warningLevel?: string;
  alreadySent: boolean;
}

const DEFAULT_FEISHU_CHAT_IDS = [
  'oc_c79f407063dc9ca9f70cc76cb4059895',
  'PUBLIC_EXAMPLE_FEISHU_MONTHLY_SCHEDULE_ACCESS_CHAT_ID',
];
const SCREENSHOT_TARGET_SELECTOR = '[data-screenshot-target="duty-overview"]';
const CAMPUS_OPERATIONS_SCREENSHOT_TARGET_SELECTOR = '[data-screenshot-target="campus-operations-dashboard"]';
const AUTOMATIC_GROUP_DELIVERY_WINDOW_MINUTES = 2 * 60;

@Injectable()
export class DutyScreenshotService {
  private readonly logger = new Logger(DutyScreenshotService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly dutyDailyReportBitableService: DutyDailyReportBitableService,
  ) {}

  async captureAndSendDutyOverview(
    options: DutyOverviewScreenshotOptions = {},
  ): Promise<DutyOverviewScreenshotResult> {
    const source = options.source || 'manual';
    const screenshotDate = this.normalizeDate(options.date) || this.formatDateKey(new Date());
    const sentAt = new Date();
    const chatIds = this.getTargetChatIds();
    const reportShift = this.resolveDailyReportShift(source, sentAt);

    this.logger.log(`开始生成值班概览截图：source=${source}, date=${screenshotDate}`);

    if (source === 'manual') {
      const screenshot = await this.captureDutyOverview(screenshotDate, source);
      const token = await this.getTenantAccessToken();
      const imageKey = await this.uploadImage(token, screenshot.buffer);
      const messageResults = await this.sendMessagesToChats(
        token,
        chatIds,
        this.buildMessageCard(
          screenshotDate,
          reportShift === 'white' ? '白班' : '夜班',
        ),
        imageKey,
      );

      this.logger.log(
        `值班概览截图已发送到飞书群：chats=${chatIds.join(', ')}, messages=${JSON.stringify(messageResults)}`,
      );

      return {
        success: true,
        source,
        message: '值班概览截图已发送到飞书群',
        screenshotDate,
        sentAt: sentAt.toISOString(),
        chatId: chatIds[0],
        chatIds,
        imageKey,
        screenshotPath: screenshot.path,
      };
    }

    let screenshot: { buffer: Buffer; path: string } | undefined;
    let dailyReport: DutyDailyReportScreenshotResult | undefined;
    let imageKey: string | undefined;
    let messageResults: Array<{
      chatId: string;
      textMessageId?: string;
      imageMessageId?: string;
    }> = [];
    let campusOperationsScreenshot:
      | { buffer: Buffer; path: string }
      | undefined;
    let campusOperationsDailyReport:
      | DutyDailyReportScreenshotResult
      | undefined;
    const failures: string[] = [];
    const dutyDeliveryKey =
      `duty-overview:${screenshotDate}:${this.getShiftFileNamePart(reportShift)}`;
    const campusArchiveKey =
      `campus-operations:${screenshotDate}:${this.getShiftFileNamePart(reportShift)}`;
    let dutyProcessingComplete =
      this.hasCompletedDutyOverviewDelivery(dutyDeliveryKey, chatIds);
    const automaticGroupDeliveryAllowed =
      this.isAutomaticGroupDeliveryAllowed(source, screenshotDate, sentAt);
    let dutyGroupMessageStatus = dutyProcessingComplete
      ? 'already-completed'
      : 'pending';
    let campusProcessingComplete =
      this.hasCompletedAutomaticArchive(campusArchiveKey);

    if (dutyProcessingComplete) {
      this.logger.log(
        `值班概览截图归档和群消息已完成，本轮仅重试园区运行截图：date=${screenshotDate}, shift=${reportShift}`,
      );
    } else {
      try {
        screenshot = await this.captureDutyOverview(screenshotDate, source);
        dailyReport = await this.dutyDailyReportBitableService.appendScreenshot({
          date: screenshotDate,
          shift: reportShift,
          image: screenshot.buffer,
          fileName: `nantong-duty-overview-${screenshotDate}-${this.getShiftFileNamePart(reportShift)}.png`,
        });
        const partialDeliveryExists =
          this.hasStartedDutyOverviewDelivery(dutyDeliveryKey, chatIds);
        if (
          automaticGroupDeliveryAllowed &&
          (dailyReport.appended !== false || partialDeliveryExists)
        ) {
          const token = await this.getTenantAccessToken();
          imageKey = await this.uploadImage(token, screenshot.buffer);
          messageResults = await this.sendMessagesToChats(
            token,
            chatIds,
            this.buildMessageCard(screenshotDate, dailyReport.shiftLabel),
            imageKey,
            dutyDeliveryKey,
          );
          dutyGroupMessageStatus = partialDeliveryExists
            ? 'resumed-partial-delivery'
            : 'sent';
        } else {
          const reason = automaticGroupDeliveryAllowed
            ? 'daily-report-attachment-already-exists'
            : 'historical-or-ended-duty-shift';
          dutyGroupMessageStatus = reason;
          this.logger.log(
            `值班概览截图仅归档，不发送飞书群消息：date=${screenshotDate}, shift=${reportShift}, reason=${reason}`,
          );
        }
        dutyProcessingComplete = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`值班概览截图处理失败：${message}`);
        this.logger.error(
          `值班概览截图处理失败，继续处理园区运行截图：date=${screenshotDate}, error=${message}`,
        );
      }
    }

    if (campusProcessingComplete) {
      this.logger.log(
        `园区运行截图已归档，本轮仅重试值班概览分支：date=${screenshotDate}, shift=${reportShift}`,
      );
    } else {
      try {
      campusOperationsScreenshot =
          await this.captureCampusOperationsDashboard(
            screenshotDate,
            source,
            reportShift,
          );
        campusOperationsDailyReport =
          await this.dutyDailyReportBitableService.appendScreenshot({
            date: screenshotDate,
            shift: reportShift,
            image: campusOperationsScreenshot.buffer,
            fileName: `nantong-campus-operations-${screenshotDate}-${this.getShiftFileNamePart(reportShift)}.png`,
          });
        this.markAutomaticArchiveCompleted(campusArchiveKey);
        campusProcessingComplete = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`园区运行截图处理失败：${message}`);
        this.logger.error(
          `园区运行截图处理失败，已完成的值班概览处理不回滚：date=${screenshotDate}, error=${message}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join('；'));
    }

    if (
      !dutyProcessingComplete ||
      !campusProcessingComplete
    ) {
      throw new Error('自动截图任务结果不完整');
    }

    this.logger.log(
      `自动截图任务已完成：groupMessageStatus=${dutyGroupMessageStatus}, chats=${chatIds.join(', ')}, reportRecord=${dailyReport?.recordId || 'already-completed'}, campusReportRecord=${campusOperationsDailyReport?.recordId || 'already-completed'}, messages=${JSON.stringify(messageResults)}`,
    );

    return {
      success: true,
      source,
      message: dutyGroupMessageStatus === 'sent' ||
        dutyGroupMessageStatus === 'resumed-partial-delivery' ||
        dutyGroupMessageStatus === 'already-completed'
        ? '值班概览群消息处理完成，值班概览和园区运行截图已追加到日报截图字段'
        : '历史或重复值班群消息已跳过，值班概览和园区运行截图已追加到日报截图字段',
      screenshotDate,
      sentAt: sentAt.toISOString(),
      chatId: chatIds[0],
      chatIds,
      imageKey,
      screenshotPath: screenshot?.path,
      dailyReport,
      campusOperationsScreenshotPath: campusOperationsScreenshot?.path,
      campusOperationsDailyReport,
    };
  }

  async captureAndSendTyphoonPath(
    options: TyphoonPathScreenshotOptions = {},
  ): Promise<TyphoonPathScreenshotResult> {
    const source = options.source || 'manual-test';
    const sentAt = new Date();
    const receivers = this.getTyphoonPathReceivers(options);
    const receiverLabels = receivers.map((item) => `${item.type}:${item.id}`);
    const chatIds = receivers
      .filter((item) => item.type === 'chat_id')
      .map((item) => item.id);
    const firstReceiver = receivers[0];

    if (
      options.deliveryKey
      && this.hasCompletedMessageDeliveryForReceivers(
        options.deliveryKey,
        receivers,
      )
    ) {
      this.logger.log(
        `台风路径截图已完成相同投递，跳过重复截图和发送：source=${source}, receivers=${receiverLabels.join(', ')}`,
      );
      return {
        success: true,
        source,
        message: '相同台风路径图操作已发送，已跳过重复投递',
        sentAt: sentAt.toISOString(),
        chatId: chatIds[0] || '',
        chatIds,
        receiveId: firstReceiver.id,
        receiveIdType: firstReceiver.type,
        warningTitle: options.warningTitle,
        warningLevel: options.warningLevel,
        alreadySent: true,
      };
    }

    this.logger.log(`开始生成台风路径截图：source=${source}, receivers=${receiverLabels.join(', ')}`);

    const screenshot = await this.captureTyphoonPath(source);
    const token = await this.getTenantAccessToken();
    const imageKey = await this.uploadImage(
      token,
      screenshot.buffer,
      `nantong-typhoon-path-${Date.now()}.png`,
    );
    const messageResults = await this.sendMessagesToReceivers(
      token,
      receivers,
      this.buildTyphoonPathMessageCard({
        sentAt,
        source,
        warningTitle: options.warningTitle,
        warningLevel: options.warningLevel,
      }),
      imageKey,
      options.deliveryKey,
    );

    this.logger.log(
      `台风路径截图已发送：receivers=${receiverLabels.join(', ')}, messages=${JSON.stringify(messageResults)}`,
    );

    return {
      success: true,
      source,
      message: firstReceiver.type === 'chat_id'
        ? '台风路径截图已发送到飞书群'
        : '台风路径截图已发送到飞书个人',
      sentAt: sentAt.toISOString(),
      chatId: chatIds[0] || '',
      chatIds,
      receiveId: firstReceiver.id,
      receiveIdType: firstReceiver.type,
      imageKey,
      screenshotPath: screenshot.path,
      warningTitle: options.warningTitle,
      warningLevel: options.warningLevel,
      alreadySent: false,
    };
  }

  hasCompletedTyphoonPathDelivery(deliveryKey: string): boolean {
    const receivers = this.getTyphoonPathChatIds().map((chatId) => ({
      id: chatId,
      type: 'chat_id' as const,
    }));
    return this.hasCompletedMessageDeliveryForReceivers(
      deliveryKey,
      receivers,
    );
  }

  private async captureDutyOverview(
    screenshotDate: string,
    source: DutyOverviewScreenshotSource,
  ): Promise<{ buffer: Buffer; path: string }> {
    return this.captureElementScreenshot({
      pageUrl: this.buildScreenshotPageUrl(screenshotDate),
      selector: SCREENSHOT_TARGET_SELECTOR,
      readySelector: `${SCREENSHOT_TARGET_SELECTOR}[data-screenshot-ready="true"]`,
      fallbackSelector: SCREENSHOT_TARGET_SELECTOR,
      screenshotDate,
      source,
      kind: 'duty-overview',
      viewportWidth: this.getPositiveIntegerEnv('DUTY_SCREENSHOT_VIEWPORT_WIDTH') || 1360,
      viewportHeight: this.getPositiveIntegerEnv('DUTY_SCREENSHOT_VIEWPORT_HEIGHT') || 922,
    });
  }

  private async captureCampusOperationsDashboard(
    screenshotDate: string,
    source: DutyOverviewScreenshotSource,
    reportShift: DutyDailyReportShift,
  ): Promise<{ buffer: Buffer; path: string }> {
    return this.captureElementScreenshot({
      pageUrl: this.buildCampusOperationsScreenshotPageUrl(
        screenshotDate,
        reportShift,
      ),
      selector: CAMPUS_OPERATIONS_SCREENSHOT_TARGET_SELECTOR,
      readySelector: `${CAMPUS_OPERATIONS_SCREENSHOT_TARGET_SELECTOR}[data-screenshot-ready="true"]`,
      fallbackSelector: CAMPUS_OPERATIONS_SCREENSHOT_TARGET_SELECTOR,
      screenshotDate,
      source,
      kind: 'campus-operations-dashboard',
      viewportWidth: this.getPositiveIntegerEnv('DUTY_CAMPUS_OPERATIONS_SCREENSHOT_VIEWPORT_WIDTH') || 1920,
      viewportHeight: this.getPositiveIntegerEnv('DUTY_CAMPUS_OPERATIONS_SCREENSHOT_VIEWPORT_HEIGHT') || 900,
    });
  }

  private async captureTyphoonPath(
    source: TyphoonPathScreenshotSource,
  ): Promise<{ buffer: Buffer; path: string }> {
    const viewportWidth = this.getPositiveIntegerEnv('TYPHOON_PATH_SCREENSHOT_VIEWPORT_WIDTH') || 1920;
    const viewportHeight = this.getPositiveIntegerEnv('TYPHOON_PATH_SCREENSHOT_VIEWPORT_HEIGHT') || 900;
    const clipWidth = Math.min(
      viewportWidth,
      this.getPositiveIntegerEnv('TYPHOON_PATH_SCREENSHOT_CLIP_WIDTH') || Math.floor(viewportWidth / 2),
    );
    const clipHeight = Math.min(
      viewportHeight,
      this.getPositiveIntegerEnv('TYPHOON_PATH_SCREENSHOT_CLIP_HEIGHT') || Math.floor((viewportHeight * 2) / 3),
    );
    const clipX = Math.min(
      viewportWidth - clipWidth,
      this.getPositiveIntegerEnv('TYPHOON_PATH_SCREENSHOT_CLIP_X') || Math.floor(clipWidth / 3),
    );
    const browserPath = this.resolveBrowserExecutablePath();
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserPath || undefined,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });

    try {
      const page = await browser.newPage({
        viewport: {
          width: viewportWidth,
          height: viewportHeight,
        },
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: true,
      });

      await page.goto(TYPHOON_PATH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`等待台风路径页面网络空闲超时，将继续截图：${message}`);
      });
      await page.waitForSelector('body', { state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(this.getPositiveIntegerEnv('TYPHOON_PATH_SCREENSHOT_WAIT_MS') || 4_000);
      await this.selectTyphoonFuture24hRainLayer(page);
      await page.waitForTimeout(
        this.getPositiveIntegerEnv('TYPHOON_PATH_RAIN_LAYER_WAIT_MS') || 8_000,
      );
      await this.dismissTyphoonPointPopup(page);
      await page.waitForTimeout(500);

      const buffer = await page.screenshot({
        type: 'png',
        fullPage: false,
        clip: {
          x: clipX,
          y: 0,
          width: clipWidth,
          height: clipHeight,
        },
        animations: 'disabled',
      });
      const path = this.saveScreenshot(
        buffer,
        this.formatDateKey(new Date()),
        source,
        'typhoon-path',
      );

      return { buffer, path };
    } finally {
      await browser.close();
    }
  }

  private async selectTyphoonFuture24hRainLayer(page: Page): Promise<void> {
    await page.locator('.icons .icon').nth(1).click({ timeout: 15_000 });
    await page.locator('.ctrls-box.rain .choose-item').first().click({ timeout: 15_000 });
    this.logger.log('台风路径截图已切换到未来24小时降雨图层');
  }

  private async dismissTyphoonPointPopup(page: Page): Promise<void> {
    await page.locator('.leaflet-container').click({
      position: { x: 1180, y: 620 },
      timeout: 15_000,
    });

    const popupCount = await page.locator('.leaflet-popup').count();
    if (popupCount > 0) {
      await page.locator('.leaflet-popup-close-button').first().click({ timeout: 5_000 });
    }
  }

  private async captureElementScreenshot(options: {
    pageUrl: string;
    selector: string;
    readySelector: string;
    fallbackSelector: string;
    screenshotDate: string;
    source: DutyOverviewScreenshotSource;
    kind: DutyScreenshotKind;
    viewportWidth: number;
    viewportHeight: number;
  }): Promise<{ buffer: Buffer; path: string }> {
    const browserPath = this.resolveBrowserExecutablePath();
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserPath || undefined,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });

    try {
      const page = await browser.newPage({
        viewport: {
          width: options.viewportWidth,
          height: options.viewportHeight,
        },
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: true,
      });

      await page.goto(options.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const buffer = await this.captureVerifiedScreenshotTarget(page, options);
      const path = this.saveScreenshot(buffer, options.screenshotDate, options.source, options.kind);

      return { buffer, path };
    } finally {
      await browser.close();
    }
  }

  private async captureVerifiedScreenshotTarget(
    page: Page,
    options: {
      readySelector: string;
      selector: string;
      fallbackSelector: string;
      kind: DutyScreenshotKind;
    },
  ): Promise<Buffer> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { target, selector } = await this.waitForScreenshotTarget(
        page,
        options,
      );

      try {
        const buffer = await target.screenshot({
          type: 'png',
          animations: 'disabled',
        });
        if (await this.isScreenshotTargetReady(target, selector)) {
          return buffer;
        }
        lastError = new Error('截图期间页面就绪状态失效');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        await target.dispose().catch(() => undefined);
      }

      this.logger.warn(
        `截图期间目标节点失效，丢弃本次图片并重试：kind=${options.kind}, attempt=${attempt}`,
      );
    }

    throw lastError || new Error(`截图目标失效：kind=${options.kind}`);
  }

  private async waitForScreenshotTarget(
    page: Page,
    options: {
      readySelector: string;
      selector: string;
      fallbackSelector: string;
      kind: DutyScreenshotKind;
    },
  ): Promise<{
    target: ElementHandle<SVGElement | HTMLElement>;
    selector: string;
  }> {
    try {
      const target = await this.waitForStableScreenshotTarget(
        page,
        options.readySelector,
      );
      return { target, selector: options.readySelector };
    } catch (error) {
      if (options.fallbackSelector === options.selector) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`截图目标未进入 ready 状态，尝试兜底选择器：kind=${options.kind}, error=${message}`);
      const target = await page.waitForSelector(options.fallbackSelector, {
        state: 'visible',
        timeout: 30_000,
      });
      if (!target) {
        throw new Error(`截图兜底目标不存在：selector=${options.fallbackSelector}`);
      }
      return { target, selector: options.fallbackSelector };
    }
  }

  private async waitForStableScreenshotTarget(
    page: Page,
    readySelector: string,
    timeoutMs = 60_000,
    stableMs = 1_500,
    pollMs = 100,
  ): Promise<ElementHandle<SVGElement | HTMLElement>> {
    const startedAt = Date.now();
    let readySince: number | undefined;
    let target: ElementHandle<SVGElement | HTMLElement> | null = null;

    while (Date.now() - startedAt <= timeoutMs) {
      const now = Date.now();
      target ||= await page.$(readySelector);
      const ready = target
        ? await this.isScreenshotTargetReady(target, readySelector)
        : false;

      if (ready && target) {
        readySince ??= now;
        if (now - readySince >= stableMs) {
          return target;
        }
      } else {
        readySince = undefined;
        if (target) {
          await target.dispose().catch(() => undefined);
          target = null;
        }
      }

      if (now - startedAt >= timeoutMs) {
        break;
      }
      await page.waitForTimeout(pollMs);
    }

    if (target) {
      await target.dispose().catch(() => undefined);
    }
    throw new Error(
      `截图目标未连续保持就绪状态：selector=${readySelector}, stableMs=${stableMs}`,
    );
  }

  private async isScreenshotTargetReady(
    target: ElementHandle<SVGElement | HTMLElement>,
    selector: string,
  ): Promise<boolean> {
    return target
      .evaluate((element, requiredSelector) => {
        if (!element.isConnected || !element.matches(requiredSelector)) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      }, selector)
      .catch(() => false);
  }

  private async getTenantAccessToken(): Promise<string> {
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      getFeishuAuthPayload(),
      { timeout: 30_000 },
    );

    if (response.data?.code !== 0) {
      throw new Error(`获取飞书 tenant_access_token 失败：${response.data?.msg || response.data?.code}`);
    }

    const token = response.data?.tenant_access_token;
    if (!token) {
      throw new Error('获取飞书 tenant_access_token 失败：响应中缺少 tenant_access_token');
    }

    return token;
  }

  private async uploadImage(
    token: string,
    image: Buffer,
    fileName = 'nantong-duty-overview.png',
  ): Promise<string> {
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', image, {
      filename: fileName,
      contentType: 'image/png',
    });

    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/im/v1/images',
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        timeout: 30_000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(`上传飞书图片失败：${response.data?.msg || response.data?.code}`);
    }

    const imageKey = response.data?.data?.image_key;
    if (!imageKey) {
      throw new Error('上传飞书图片失败：响应中缺少 image_key');
    }

    return imageKey;
  }

  private async sendCardMessage(
    token: string,
    receiveId: string,
    card: Record<string, unknown>,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
    uuid?: string,
  ): Promise<string | undefined> {
    const response = await this.httpService.axiosRef.post(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
        ...(uuid ? { uuid } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30_000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(`发送飞书卡片消息失败：${response.data?.msg || response.data?.code}`);
    }

    return response.data?.data?.message_id;
  }

  private async sendImageMessage(
    token: string,
    receiveId: string,
    imageKey: string,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
    uuid?: string,
  ): Promise<string | undefined> {
    const response = await this.httpService.axiosRef.post(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: receiveId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
        ...(uuid ? { uuid } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30_000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(`发送飞书图片消息失败：${response.data?.msg || response.data?.code}`);
    }

    return response.data?.data?.message_id;
  }

  private async sendMessagesToChats(
    token: string,
    chatIds: string[],
    card: Record<string, unknown>,
    imageKey: string,
    deliveryKey?: string,
  ): Promise<Array<{ chatId: string; textMessageId?: string; imageMessageId?: string }>> {
    const results = await this.sendMessagesToReceivers(
      token,
      chatIds.map((chatId) => ({ id: chatId, type: 'chat_id' })),
      card,
      imageKey,
      deliveryKey,
    );

    return results.map((item) => ({
      chatId: item.receiveId,
      textMessageId: item.textMessageId,
      imageMessageId: item.imageMessageId,
    }));
  }

  private async sendMessagesToReceivers(
    token: string,
    receivers: FeishuMessageReceiver[],
    card: Record<string, unknown>,
    imageKey: string,
    deliveryKey?: string,
  ): Promise<Array<{
    receiveId: string;
    receiveIdType: FeishuReceiveIdType;
    textMessageId?: string;
    imageMessageId?: string;
  }>> {
    const receiverResults: Array<{
      receiveId: string;
      receiveIdType: FeishuReceiveIdType;
      textMessageId?: string;
      imageMessageId?: string;
    }> = [];
    const failures: Array<{ receiveId: string; receiveIdType: FeishuReceiveIdType; message: string }> = [];

    for (const receiver of receivers) {
      try {
        const cardDelivery = this.getMessageDelivery(
          deliveryKey,
          receiver,
          'card',
        );
        const completedCard = cardDelivery
          ? this.getCompletedMessageDelivery(cardDelivery.stateKey)
          : undefined;
        const textMessageId = completedCard
          ? completedCard.messageId
          : await this.sendCardMessage(
              token,
              receiver.id,
              card,
              receiver.type,
              cardDelivery?.uuid,
            );
        if (cardDelivery && !completedCard) {
          this.markMessageDeliveryCompleted(
            cardDelivery.stateKey,
            textMessageId,
          );
        }

        const imageDelivery = this.getMessageDelivery(
          deliveryKey,
          receiver,
          'image',
        );
        const completedImage = imageDelivery
          ? this.getCompletedMessageDelivery(imageDelivery.stateKey)
          : undefined;
        const imageMessageId = completedImage
          ? completedImage.messageId
          : await this.sendImageMessage(
              token,
              receiver.id,
              imageKey,
              receiver.type,
              imageDelivery?.uuid,
            );
        if (imageDelivery && !completedImage) {
          this.markMessageDeliveryCompleted(
            imageDelivery.stateKey,
            imageMessageId,
          );
        }

        receiverResults.push({
          receiveId: receiver.id,
          receiveIdType: receiver.type,
          textMessageId,
          imageMessageId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ receiveId: receiver.id, receiveIdType: receiver.type, message });
        this.logger.warn(`发送飞书截图失败：receiver=${receiver.type}:${receiver.id}, error=${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `发送飞书截图失败：${failures.map((item) => `${item.receiveIdType}:${item.receiveId} ${item.message}`).join('；')}`,
      );
    }

    return receiverResults;
  }

  private getMessageDelivery(
    deliveryKey: string | undefined,
    receiver: FeishuMessageReceiver,
    kind: DutyScreenshotDeliveryKind,
  ): { stateKey: string; uuid: string } | undefined {
    if (!deliveryKey) return undefined;

    const digest = createHash('sha256')
      .update(
        [deliveryKey, receiver.type, receiver.id, kind].join('|'),
        'utf8',
      )
      .digest('hex');
    return {
      stateKey: digest,
      uuid: `duty-${digest.slice(0, 40)}`,
    };
  }

  private hasCompletedDutyOverviewDelivery(
    deliveryKey: string,
    chatIds: string[],
  ): boolean {
    return this.hasCompletedMessageDeliveryForReceivers(
      deliveryKey,
      chatIds.map((chatId) => ({ id: chatId, type: 'chat_id' })),
    );
  }

  private hasCompletedMessageDeliveryForReceivers(
    deliveryKey: string,
    receivers: FeishuMessageReceiver[],
  ): boolean {
    return receivers.every((receiver) =>
      (['card', 'image'] as const).every((kind) => {
        const delivery = this.getMessageDelivery(
          deliveryKey,
          receiver,
          kind,
        );
        return Boolean(
          delivery && this.getCompletedMessageDelivery(delivery.stateKey),
        );
      }),
    );
  }

  private hasStartedDutyOverviewDelivery(
    deliveryKey: string,
    chatIds: string[],
  ): boolean {
    return chatIds.some((chatId) =>
      (['card', 'image'] as const).some((kind) => {
        const delivery = this.getMessageDelivery(
          deliveryKey,
          { id: chatId, type: 'chat_id' },
          kind,
        );
        return Boolean(
          delivery && this.getCompletedMessageDelivery(delivery.stateKey),
        );
      }),
    );
  }

  private hasCompletedAutomaticArchive(archiveKey: string): boolean {
    return Boolean(
      this.getCompletedMessageDelivery(
        this.getAutomaticArchiveStateKey(archiveKey),
      ),
    );
  }

  private markAutomaticArchiveCompleted(archiveKey: string): void {
    this.markMessageDeliveryCompleted(
      this.getAutomaticArchiveStateKey(archiveKey),
    );
  }

  private getAutomaticArchiveStateKey(archiveKey: string): string {
    return createHash('sha256')
      .update(`archive|${archiveKey}`, 'utf8')
      .digest('hex');
  }

  private getCompletedMessageDelivery(
    stateKey: string,
  ): CompletedDutyScreenshotDelivery | undefined {
    return this.readMessageDeliveryState().completed[stateKey];
  }

  private readMessageDeliveryState(): DutyScreenshotDeliveryState {
    const statePath = this.getMessageDeliveryStatePath();
    if (!existsSync(statePath)) {
      return { version: 1, completed: {} };
    }

    try {
      const parsed = JSON.parse(
        readFileSync(statePath, 'utf8'),
      ) as Partial<DutyScreenshotDeliveryState>;
      if (
        parsed.version === 1 &&
        parsed.completed &&
        typeof parsed.completed === 'object'
      ) {
        return {
          version: 1,
          completed: parsed.completed,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `读取值班截图消息投递状态失败，将结合稳定 uuid 重试：${message}`,
      );
    }

    return { version: 1, completed: {} };
  }

  private markMessageDeliveryCompleted(
    stateKey: string,
    messageId?: string,
  ): void {
    const state = this.readMessageDeliveryState();
    state.completed[stateKey] = {
      completedAt: new Date().toISOString(),
      ...(messageId ? { messageId } : {}),
    };

    const statePath = this.getMessageDeliveryStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(tempPath, statePath);
    } finally {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  }

  private getMessageDeliveryStatePath(): string {
    return resolveDutyDailyReportStateFilePath({
      fileName: 'duty-screenshot-delivery-state.json',
      explicitPath: process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH,
      configuredDirectory: process.env.DUTY_DAILY_REPORT_STATE_DIR,
    });
  }

  private buildScreenshotPageUrl(screenshotDate: string): string {
    const configuredUrl = readEnv('DUTY_SCREENSHOT_PAGE_URL', ['SCREENSHOT_PAGE_URL']);
    const host = this.getScreenshotServerHost();
    const port = process.env.SERVER_PORT || '3000';
    const hasHttpsConfig = Boolean(process.env.HTTPS_KEY_PATH?.trim() && process.env.HTTPS_CERT_PATH?.trim());
    const protocol = hasHttpsConfig ? 'https' : 'http';
    const serverBaseUrl = `${protocol}://${host}:${port}`;
    const baseUrl = configuredUrl
      || process.env.PUBLIC_BASE_URL
      || (process.env.NODE_ENV === 'production' ? serverBaseUrl : process.env.FORCE_FRAMEWORK_DOMAIN_MAIN)
      || serverBaseUrl;
    const url = new URL(baseUrl);
    this.normalizeScreenshotUrlHost(url);

    url.pathname = this.buildScreenshotPagePath(
      url.pathname,
      'monthly-schedule',
    );
    url.searchParams.set('screenshot', '1');
    url.searchParams.set('screenshotDate', screenshotDate);
    url.searchParams.set(
      'screenshotToken',
      createMonthlyScheduleScreenshotAccessToken(screenshotDate),
    );

    return url.toString();
  }

  private buildCampusOperationsScreenshotPageUrl(
    screenshotDate: string,
    shift: DutyDailyReportShift = 'white',
  ): string {
    const configuredUrl = readEnv('DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL', [
      'CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
    ]);
    const sharedScreenshotUrl = readEnv('DUTY_SCREENSHOT_PAGE_URL', [
      'SCREENSHOT_PAGE_URL',
    ]);
    const host = this.getScreenshotServerHost();
    const port = process.env.SERVER_PORT || '3000';
    const hasHttpsConfig = Boolean(
      process.env.HTTPS_KEY_PATH?.trim() &&
        process.env.HTTPS_CERT_PATH?.trim(),
    );
    const protocol = hasHttpsConfig ? 'https' : 'http';
    const localServerUrl = `${protocol}://${host}:${port}`;
    const url = new URL(
      configuredUrl || sharedScreenshotUrl || localServerUrl,
    );
    this.normalizeScreenshotUrlHost(url);

    if (configuredUrl) {
      url.pathname = this.buildScreenshotPagePath(
        url.pathname,
        'campus-operations-dashboard',
      );
    } else if (sharedScreenshotUrl) {
      url.pathname = this.buildSiblingScreenshotPath(
        this.buildScreenshotPagePath(url.pathname, 'monthly-schedule'),
        'campus-operations-dashboard',
      );
    } else {
      url.pathname = this.buildScreenshotPagePath(
        url.pathname,
        'campus-operations-dashboard',
      );
    }
    url.searchParams.set('screenshot', '1');
    url.searchParams.set('screenshotDate', screenshotDate);
    url.searchParams.set('screenshotShift', shift);
    url.searchParams.set(
      'screenshotToken',
      createCampusOperationsScreenshotAccessToken(screenshotDate, shift),
    );

    return url.toString();
  }

  private getScreenshotServerHost(): string {
    const host = String(process.env.SERVER_HOST || '').trim();
    if (!host || host === '0.0.0.0' || host === '::' || host === '[::]') {
      return 'localhost';
    }
    return host;
  }

  private normalizeScreenshotUrlHost(url: URL): void {
    const host = url.hostname.toLowerCase();
    if (host === '0.0.0.0' || host === '::' || host === '[::]') {
      url.hostname = 'localhost';
    }
  }

  private buildScreenshotPagePath(
    pathname: string,
    targetPage: string,
  ): string {
    const normalizedPath = `/${String(pathname || '')}`
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '');
    const configuredBasePath = String(process.env.CLIENT_BASE_PATH || '').trim();
    const clientBasePath =
      !configuredBasePath || configuredBasePath === '/'
        ? ''
        : `/${configuredBasePath.replace(/^\/+|\/+$/g, '')}`;

    if (!normalizedPath || normalizedPath === '/') {
      return `${clientBasePath}/${targetPage}`;
    }
    if (
      clientBasePath &&
      normalizedPath.toLowerCase() === clientBasePath.toLowerCase()
    ) {
      return `${normalizedPath}/${targetPage}`;
    }
    return normalizedPath;
  }

  private buildSiblingScreenshotPath(
    pathname: string,
    targetPage: string,
  ): string {
    const normalized = `/${String(pathname || '')}`
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '');
    const monthlyScheduleSuffix = '/monthly-schedule';
    if (normalized.toLowerCase().endsWith(monthlyScheduleSuffix)) {
      const prefix = normalized.slice(0, -monthlyScheduleSuffix.length);
      return `${prefix}/${targetPage}` || `/${targetPage}`;
    }
    if (!normalized || normalized === '/') return `/${targetPage}`;
    return `${normalized}/${targetPage}`;
  }

  private buildMessageCard(
    screenshotDate: string,
    shiftLabel: string,
  ): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'red',
        title: {
          tag: 'plain_text',
          content: '南通机房今日排班一览',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `日期：${screenshotDate}\n班次：${shiftLabel}`,
          },
        },
      ],
    };
  }

  private buildTyphoonPathMessageCard(options: {
    sentAt: Date;
    source: TyphoonPathScreenshotSource;
    warningTitle?: string;
    warningLevel?: string;
  }): Record<string, unknown> {
    const lines = [
      options.warningTitle ? `预警：${options.warningTitle}` : '',
      options.warningLevel ? `等级：${options.warningLevel}` : '',
      `时间：${this.formatDateTime(options.sentAt)}`,
    ].filter(Boolean);

    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: options.warningLevel === '蓝色' ? 'blue' : 'orange',
        title: {
          tag: 'plain_text',
          content: '台风路径图',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: lines.join('\n'),
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '打开台风网',
              },
              type: 'primary',
              url: TYPHOON_PATH_URL,
            },
          ],
        },
      ],
    };
  }

  private saveScreenshot(
    buffer: Buffer,
    screenshotDate: string,
    source: DutyScreenshotSource,
    kind: DutyScreenshotKind,
  ): string {
    const dir = readEnv('DUTY_SCREENSHOT_SAVE_DIR', ['SCREENSHOT_SAVE_DIR'])
      || join(process.cwd(), 'data', 'screenshots');
    mkdirSync(dir, { recursive: true });

    const fileName = `${kind}-${screenshotDate}-${source.replace(':', '')}-${Date.now()}.png`;
    const filePath = join(dir, fileName);
    writeFileSync(filePath, buffer);
    return filePath;
  }

  private getTyphoonPathChatIds(chatId?: string): string[] {
    const configuredChatId = readEnv('FEISHU_TYPHOON_PATH_CHAT_ID', [
      'TYPHOON_PATH_CHAT_ID',
    ]);
    return this.uniqueStrings([
      chatId,
      configuredChatId,
      DEFAULT_TYPHOON_PATH_CHAT_ID,
    ].filter(Boolean));
  }

  private getTyphoonPathReceivers(
    options: TyphoonPathScreenshotOptions,
  ): FeishuMessageReceiver[] {
    if (options.receiveId) {
      return [{
        id: options.receiveId,
        type: options.receiveIdType || 'open_id',
      }];
    }

    if (options.source === 'manual-test') {
      throw new Error('测试台风路径截图需要指定个人接收 ID');
    }

    return this.getTyphoonPathChatIds(options.chatId).map((chatId) => ({
      id: chatId,
      type: 'chat_id',
    }));
  }

  private getTargetChatIds(): string[] {
    const configuredList = readEnv('FEISHU_SCREENSHOT_CHAT_IDS', [
      'FEISHU_DUTY_SCREENSHOT_CHAT_IDS',
    ]);
    if (configuredList) {
      return this.parseChatIdList(configuredList);
    }

    const legacyChatId = readEnv('FEISHU_SCREENSHOT_CHAT_ID', ['FEISHU_DUTY_SCREENSHOT_CHAT_ID']);
    return this.uniqueStrings([legacyChatId, ...DEFAULT_FEISHU_CHAT_IDS].filter(Boolean));
  }

  private parseChatIdList(value: string): string[] {
    const chatIds = this.uniqueStrings(
      value
        .split(/[,，;\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    );

    if (chatIds.length === 0) {
      throw new Error('飞书截图群配置为空，请检查 FEISHU_SCREENSHOT_CHAT_IDS');
    }
    return chatIds;
  }

  private uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
  }

  private resolveDailyReportShift(
    source: DutyOverviewScreenshotSource,
    sentAt: Date,
  ): DutyDailyReportShift {
    if (source === 'auto-08:50') return 'white';
    if (source === 'auto-17:50') return 'night';
    return sentAt.getHours() < 16 ? 'white' : 'night';
  }

  private getShiftFileNamePart(shift: DutyDailyReportShift): string {
    return shift === 'white' ? 'white' : 'night';
  }

  private resolveBrowserExecutablePath(): string | undefined {
    const configuredPath = readEnv('DUTY_SCREENSHOT_BROWSER_PATH', [
      'SCREENSHOT_BROWSER_PATH',
      'CHROME_PATH',
      'EDGE_PATH',
    ]);
    if (configuredPath) {
      if (!existsSync(configuredPath)) {
        throw new Error(`截图浏览器路径不存在：${configuredPath}`);
      }
      return configuredPath;
    }

    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ];

    return candidates.find((candidate) => existsSync(candidate));
  }

  private getPositiveIntegerEnv(name: string): number | null {
    const value = Number.parseInt(readEnv(name), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  private normalizeDate(value?: string): string | null {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('截图日期格式不正确，请使用 YYYY-MM-DD');
    }
    return value;
  }

  private isAutomaticGroupDeliveryAllowed(
    source: DutyOverviewScreenshotSource,
    screenshotDate: string,
    now: Date,
  ): boolean {
    if (source === 'manual') return true;

    const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const shanghaiDate = [
      shanghaiNow.getUTCFullYear(),
      String(shanghaiNow.getUTCMonth() + 1).padStart(2, '0'),
      String(shanghaiNow.getUTCDate()).padStart(2, '0'),
    ].join('-');
    if (screenshotDate !== shanghaiDate) return false;

    const shanghaiMinutes =
      shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
    const whiteShiftStartMinutes = 8 * 60 + 50;
    const nightShiftStartMinutes = 17 * 60 + 50;
    if (source === 'auto-08:50') {
      return (
        shanghaiMinutes >= whiteShiftStartMinutes &&
        shanghaiMinutes <
          whiteShiftStartMinutes + AUTOMATIC_GROUP_DELIVERY_WINDOW_MINUTES
      );
    }
    return (
      shanghaiMinutes >= nightShiftStartMinutes &&
      shanghaiMinutes <
        nightShiftStartMinutes + AUTOMATIC_GROUP_DELIVERY_WINDOW_MINUTES
    );
  }

  private formatDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private formatDateTime(date: Date): string {
    return `${this.formatDateKey(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

}
