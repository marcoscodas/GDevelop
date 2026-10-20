// @flow
import TauriBridge from '../Utils/Tauri/TauriBridge';

jest.mock('../Utils/Tauri/TauriBridge');
jest.mock('../Utils/Tauri/isTauri', () => ({ isTauri: () => true }));

const { findGDJS } = require('./BrowserS3GDJSFinder');

const toBase64 = (text: string) =>
  // $FlowFixMe[cannot-resolve-name] - Node's Buffer, available in Jest.
  Buffer.from(text, 'utf-8').toString('base64');

describe('BrowserS3GDJSFinder (Tauri branch)', () => {
  it('fetches every file for a file set via TauriBridge.httpFetch, not the global fetch', async () => {
    // $FlowFixMe[prop-missing]
    TauriBridge.httpFetch.mockImplementation(async ({ url }: { url: string }) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      bodyBase64: toBase64(`content of ${url}`),
    }));

    const { filesContent } = await findGDJS('preview');

    expect(TauriBridge.httpFetch).toHaveBeenCalled();
    // $FlowFixMe[prop-missing] - jest.fn() mock.
    const call = TauriBridge.httpFetch.mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.url).toContain('/Runtime/index.html');
    expect(filesContent).toHaveLength(1);
    expect(filesContent[0].text).toBe(`content of ${filesContent[0].filePath}`);
  });

  it('throws with the status code on a non-2xx response, same shape as the browser-fetch branch', async () => {
    // $FlowFixMe[prop-missing]
    TauriBridge.httpFetch.mockResolvedValueOnce({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      bodyBase64: '',
    });

    await expect(findGDJS('preview')).rejects.toThrow(/status: 404/);
  });
});
