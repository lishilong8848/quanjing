import { createHash } from 'node:crypto';

import {
  fetchOfficialChinaWorkCalendar,
  findOfficialNoticeUrl,
  parseOfficialHolidayNotice,
} from '../../server/modules/duty-schedule/china-work-calendar-source';

const YEAR = 2031;
const TITLE = `国务院办公厅关于${YEAR}年部分节假日安排的通知`;
const SOURCE_URL =
  'https://www.gov.cn/zhengce/zhengceku/203011/content_7100001.htm';
const RETRIEVED_AT = '2030-11-06T01:02:03.000Z';

const SECTIONS = [
  '一、元旦：12月31日至1月1日放假调休，共2天。1月2日上班。',
  '二、春节：2月10日至12日放假调休，共3天。2月8日、15日上班。',
  '三、清明节：4月5日放假1天，不调休。',
  '四、劳动节：5月1日至3日放假调休，共3天。5月4日上班。',
  '五、端午节：6月10日放假1天。',
  '六、中秋节、国庆节：9月29日至10月6日放假调休，共8天。10月7日、8日上班。',
];

function createNoticeHtml(
  overrides: {
    title?: string;
    noticeNumber?: string;
    office?: string;
    publishedDate?: string;
    sections?: string[];
  } = {},
): string {
  const title = overrides.title ?? TITLE;
  const noticeNumber = overrides.noticeNumber ?? `国办发明电〔${YEAR - 1}〕9号`;
  const office = overrides.office ?? '国务院办公厅';
  const publishedDate = overrides.publishedDate ?? `${YEAR - 1}年11月5日`;
  const sections = overrides.sections ?? SECTIONS;

  return `<!doctype html><html><body>
    <div id="outside">不应进入正文哈希</div>
    <div class="pages_content" id="UCAP-CONTENT">
      <p><strong>${title}</strong></p>
      <p>${noticeNumber}</p>
      <p>经国务院批准，现将${YEAR}年元旦、春节、清明节、劳动节、端午节、中秋节和国庆节放假调休日期通知如下。</p>
      ${sections.map((section) => `<p>${section}</p>`).join('')}
      <p>${office}</p>
      <p>${publishedDate}</p>
    </div>
    <div>正文之外</div>
  </body></html>`;
}

function officialSearchPayload(
  list: Array<{ title: string; url: string }>,
): unknown {
  return {
    code: 200,
    searchVO: {
      catMap: {
        gongwen: { listVO: list },
      },
    },
  };
}

describe('China work calendar official source', () => {
  describe('findOfficialNoticeUrl', () => {
    it('selects only the exact highlighted title on the official HTTPS policy path', () => {
      const payload = officialSearchPayload([
        {
          title: `<em>${TITLE}</em>`,
          url: 'https://evil.example/zhengce/content_1.htm',
        },
        {
          title:
            '<em>国务院办公厅</em><em>关于</em><em>2031</em><em>年</em><em>部分节假日安排的通知</em>',
          url: SOURCE_URL,
        },
        {
          title: TITLE,
          url: 'https://www.gov.cn/gongbao/2030/content_1.htm',
        },
      ]);

      expect(findOfficialNoticeUrl(payload, YEAR)).toBe(SOURCE_URL);
    });

    it('returns null instead of guessing from a similar title or unsafe URL', () => {
      expect(
        findOfficialNoticeUrl(
          officialSearchPayload([
            {
              title: `${TITLE}（转载）`,
              url: SOURCE_URL,
            },
            {
              title: TITLE,
              url: 'http://www.gov.cn/zhengce/content_1.htm',
            },
          ]),
          YEAR,
        ),
      ).toBeNull();
    });

    it('throws instead of choosing between distinct exact official results', () => {
      expect(() =>
        findOfficialNoticeUrl(
          officialSearchPayload([
            { title: TITLE, url: SOURCE_URL },
            {
              title: `<em>${TITLE}</em>`,
              url: 'https://www.gov.cn/zhengce/203011/content_7100002.htm',
            },
          ]),
          YEAR,
        ),
      ).toThrow('多个');
    });
  });

  describe('parseOfficialHolidayNotice', () => {
    it('parses single-day, omitted-month, cross-month, cross-year and combined holidays', () => {
      const snapshot = parseOfficialHolidayNotice({
        year: YEAR,
        url: SOURCE_URL,
        html: createNoticeHtml(),
        retrievedAt: RETRIEVED_AT,
      });

      expect(snapshot).toMatchObject({
        year: YEAR,
        source: `中国政府网《${TITLE}》（国办发明电〔2030〕9号）`,
        sourceUrl: SOURCE_URL,
        noticeNumber: '国办发明电〔2030〕9号',
        publishedAt: '2030-11-05',
        retrievedAt: RETRIEVED_AT,
      });
      expect(snapshot.holidays).toMatchObject({
        '2030-12-31': '元旦',
        '2031-01-01': '元旦',
        '2031-02-10': '春节',
        '2031-02-11': '春节',
        '2031-02-12': '春节',
        '2031-04-05': '清明节',
        '2031-05-01': '劳动节',
        '2031-05-03': '劳动节',
        '2031-06-10': '端午节',
        '2031-09-29': '中秋节、国庆节',
        '2031-10-06': '中秋节、国庆节',
      });
      expect(Object.keys(snapshot.holidays)).toHaveLength(18);
      expect(snapshot.adjustedWorkdays).toEqual([
        '2031-01-02',
        '2031-02-08',
        '2031-02-15',
        '2031-05-04',
        '2031-10-07',
        '2031-10-08',
      ]);
      expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('hashes normalized semantic content rather than HTML presentation', () => {
      const plain = parseOfficialHolidayNotice({
        year: YEAR,
        url: SOURCE_URL,
        html: createNoticeHtml(),
        retrievedAt: RETRIEVED_AT,
      });
      const restyledHtml = createNoticeHtml()
        .replace('<p><strong>', '<p class="title">\n<strong><span>')
        .replace('</strong></p>', '</span></strong>\n</p>')
        .replace(/<p>/g, '<p data-layout="changed">\n')
        .replace(/<\/p>/g, '\n</p>');
      const restyled = parseOfficialHolidayNotice({
        year: YEAR,
        url: SOURCE_URL,
        html: restyledHtml,
        retrievedAt: '2030-11-07T00:00:00.000Z',
      });

      expect(restyled.contentHash).toBe(plain.contentHash);
      expect(restyled.contentHash).toBe(
        createHash('sha256')
          .update(
            [
              TITLE,
              '国办发明电〔2030〕9号',
              `经国务院批准，现将${YEAR}年元旦、春节、清明节、劳动节、端午节、中秋节和国庆节放假调休日期通知如下。`,
              ...SECTIONS,
              '国务院办公厅',
              '2030年11月5日',
            ].join(''),
          )
          .digest('hex'),
      );
    });

    it.each([
      ['非官方 URL', { url: 'https://gov.cn/zhengce/content_1.htm' }],
      ['标题不精确', { html: createNoticeHtml({ title: `${TITLE}（解读）` }) }],
      ['缺少落款单位', { html: createNoticeHtml({ office: '某办公厅' }) }],
      [
        '文号无效',
        { html: createNoticeHtml({ noticeNumber: '国办发〔2030〕9号' }) },
      ],
      [
        '发布日期无效',
        { html: createNoticeHtml({ publishedDate: '2030年2月30日' }) },
      ],
      [
        '缺少七个节日语义',
        { html: createNoticeHtml({ sections: SECTIONS.slice(0, 5) }) },
      ],
      [
        '节假日与调休上班日重叠',
        {
          html: createNoticeHtml({
            sections: [`${SECTIONS[0]}1月1日上班。`, ...SECTIONS.slice(1)],
          }),
        },
      ],
    ])('rejects %s', (_label, override) => {
      expect(() =>
        parseOfficialHolidayNotice({
          year: YEAR,
          url: override.url ?? SOURCE_URL,
          html: override.html ?? createNoticeHtml(),
          retrievedAt: RETRIEVED_AT,
        }),
      ).toThrow();
    });
  });

  describe('fetchOfficialChinaWorkCalendar', () => {
    it('searches the fixed official endpoint by exact title and parses its official page', async () => {
      const get = jest
        .fn()
        .mockResolvedValueOnce({
          data: officialSearchPayload([
            { title: `<em>${TITLE}</em>`, url: SOURCE_URL },
          ]),
        })
        .mockResolvedValueOnce({ data: createNoticeHtml() });

      const snapshot = await fetchOfficialChinaWorkCalendar(
        { get },
        YEAR,
        4_321,
      );

      expect(snapshot?.sourceUrl).toBe(SOURCE_URL);
      expect(get).toHaveBeenNthCalledWith(
        1,
        'https://sousuo.www.gov.cn/search-gov/data',
        expect.objectContaining({
          timeout: 4_321,
          params: expect.objectContaining({
            q: TITLE,
            searchfield: 'title',
          }),
        }),
      );
      expect(get).toHaveBeenNthCalledWith(
        2,
        SOURCE_URL,
        expect.objectContaining({ timeout: 4_321, responseType: 'text' }),
      );
    });

    it('returns null without fetching a page when the exact notice is unpublished', async () => {
      const get = jest.fn().mockResolvedValue({
        data: officialSearchPayload([]),
      });

      await expect(
        fetchOfficialChinaWorkCalendar({ get }, YEAR, 4_321),
      ).resolves.toBeNull();
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('treats the official code 1001 empty result as unpublished, not a failure', async () => {
      const get = jest.fn().mockResolvedValue({
        data: {
          code: 1001,
          msg: '抱歉，没有找到相关结果',
          data: null,
          searchVO: null,
        },
      });

      await expect(
        fetchOfficialChinaWorkCalendar({ get }, YEAR, 4_321),
      ).resolves.toBeNull();
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('still rejects other non-success official business codes', async () => {
      const get = jest.fn().mockResolvedValue({
        data: { code: 1002, msg: '请求参数无效', searchVO: null },
      });

      await expect(
        fetchOfficialChinaWorkCalendar({ get }, YEAR, 4_321),
      ).rejects.toThrow(/政策搜索请求失败/);
    });
  });
});
