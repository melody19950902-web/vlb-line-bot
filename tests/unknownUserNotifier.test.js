'use strict';

let mockMembers = [{ name: '阿啾', id: 'U1604db7615d2864557e6110e981ef503' }];
let mockToday = '2026/08/14';

jest.mock('../src/sheets', () => ({
  getAllMembers:       jest.fn(async () => mockMembers.map(m => ({ ...m }))),
  getTaiwanDateString: jest.fn(() => mockToday),
}));

const MANAGER_ID = 'U11111111111111111111111111111111';
process.env.MANAGER_USER_IDS = MANAGER_ID;

const { maybeNotifyUnknownUser, _resetForTest } = require('../src/unknownUserNotifier');

function makeClient() {
  return { pushMessage: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  _resetForTest();
  mockMembers = [{ name: '阿啾', id: 'U1604db7615d2864557e6110e981ef503' }];
  mockToday = '2026/08/14';
});

describe('maybeNotifyUnknownUser', () => {
  test('未登記使用者：推播給主管，內含 userId、訊息預覽、範本', async () => {
    const client = makeClient();
    await maybeNotifyUnknownUser({
      userId: 'U9999999999999999999999999999999z',
      text:   '你好',
      sourceType: 'user',
      client,
    });
    expect(client.pushMessage).toHaveBeenCalledTimes(1);
    const call = client.pushMessage.mock.calls[0][0];
    expect(call.to).toBe(MANAGER_ID);
    const body = call.messages[0].text;
    expect(body).toContain('未登記使用者');
    expect(body).toContain('U9999999999999999999999999999999z');
    expect(body).toContain('你好');
    expect(body).toContain('新增成員');
  });

  test('主管本人：不推播', async () => {
    const client = makeClient();
    await maybeNotifyUnknownUser({
      userId: MANAGER_ID, text: '測試', sourceType: 'user', client,
    });
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  test('已在成員名單：不推播', async () => {
    const client = makeClient();
    await maybeNotifyUnknownUser({
      userId: 'U1604db7615d2864557e6110e981ef503',
      text: '正常日 3', sourceType: 'user', client,
    });
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  test('群組訊息：不推播（僅私訊）', async () => {
    const client = makeClient();
    await maybeNotifyUnknownUser({
      userId: 'U9999999999999999999999999999999z',
      text: 'hi', sourceType: 'group', client,
    });
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  test('同日重複：只推第一次', async () => {
    const client = makeClient();
    const unknown = 'U9999999999999999999999999999999z';
    await maybeNotifyUnknownUser({ userId: unknown, text: 'a', sourceType: 'user', client });
    await maybeNotifyUnknownUser({ userId: unknown, text: 'b', sourceType: 'user', client });
    await maybeNotifyUnknownUser({ userId: unknown, text: 'c', sourceType: 'user', client });
    expect(client.pushMessage).toHaveBeenCalledTimes(1);
  });

  test('跨日重新計算：新的一天可再推一次', async () => {
    const client = makeClient();
    const unknown = 'U9999999999999999999999999999999z';
    mockToday = '2026/08/14';
    await maybeNotifyUnknownUser({ userId: unknown, text: 'a', sourceType: 'user', client });
    expect(client.pushMessage).toHaveBeenCalledTimes(1);
    mockToday = '2026/08/15';
    await maybeNotifyUnknownUser({ userId: unknown, text: 'b', sourceType: 'user', client });
    expect(client.pushMessage).toHaveBeenCalledTimes(2);
  });

  test('訊息預覽超過 50 字截斷 + 加省略號', async () => {
    const client = makeClient();
    const long = 'x'.repeat(80);
    await maybeNotifyUnknownUser({
      userId: 'U9999999999999999999999999999999z',
      text: long, sourceType: 'user', client,
    });
    const body = client.pushMessage.mock.calls[0][0].messages[0].text;
    expect(body).toContain('x'.repeat(50) + '…');
    expect(body).not.toContain('x'.repeat(51));
  });

  test('多位主管：都會收到', async () => {
    process.env.MANAGER_USER_IDS = `${MANAGER_ID},U22222222222222222222222222222222`;
    const client = makeClient();
    await maybeNotifyUnknownUser({
      userId: 'U9999999999999999999999999999999z',
      text: 'hi', sourceType: 'user', client,
    });
    expect(client.pushMessage).toHaveBeenCalledTimes(2);
    process.env.MANAGER_USER_IDS = MANAGER_ID;
  });

  test('pushMessage 失敗不會炸掉呼叫端', async () => {
    const client = { pushMessage: jest.fn().mockRejectedValue(new Error('LINE down')) };
    await expect(maybeNotifyUnknownUser({
      userId: 'U9999999999999999999999999999999z',
      text: 'hi', sourceType: 'user', client,
    })).resolves.not.toThrow();
  });
});
