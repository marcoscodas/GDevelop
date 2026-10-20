// @flow
import axios from 'axios';
import TauriBridge from './TauriBridge';
import tauriAxiosAdapter from './AxiosTauriAdapter';

jest.mock('./TauriBridge');

// Same reasoning as AxiosTauriAdapter.js: Jest's node environment doesn't
// expose `Blob` as a global.
const BlobCtor = typeof Blob !== 'undefined' ? Blob : require('buffer').Blob;

// Exercises the real axios request pipeline (dispatchRequest, settle,
// transformResponse) against the adapter, not just the adapter function in
// isolation - this is the integration surface the ~18 GDevelopServices
// files actually depend on.
const client = axios.create({ adapter: tauriAxiosAdapter });

const toBase64 = (text: string) =>
  Buffer.from(text, 'utf-8').toString('base64');

describe('AxiosTauriAdapter', () => {
  it('builds the URL (including query params) and forwards method/headers to TauriBridge.httpFetch', async () => {
    // $FlowFixMe[prop-missing] - jest.fn() mock.
    TauriBridge.httpFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      bodyBase64: toBase64('{"ok":true}'),
    });

    const response = await client.get('https://api.gdevelop.io/game', {
      params: { userId: 'abc', page: 2 },
      headers: { Authorization: 'Bearer token-123' },
    });

    expect(TauriBridge.httpFetch).toHaveBeenCalledTimes(1);
    const request = TauriBridge.httpFetch.mock.calls[0][0];
    expect(request.method).toBe('get');
    expect(request.url).toBe(
      'https://api.gdevelop.io/game?userId=abc&page=2'
    );
    expect(request.headers.Authorization).toBe('Bearer token-123');

    // axios's own transformResponse (not the adapter) parses this JSON.
    expect(response.data).toEqual({ ok: true });
    expect(response.status).toBe(200);
  });

  it('base64-encodes a JSON request body', async () => {
    // $FlowFixMe[prop-missing]
    TauriBridge.httpFetch.mockResolvedValueOnce({
      status: 201,
      statusText: 'Created',
      headers: {},
      bodyBase64: toBase64('{}'),
    });

    await client.post('https://api.gdevelop.io/game', { name: 'My game' });

    const request = TauriBridge.httpFetch.mock.calls[0][0];
    expect(request.bodyBase64).toBeDefined();
    expect(
      Buffer.from(request.bodyBase64, 'base64').toString('utf-8')
    ).toBe('{"name":"My game"}');
  });

  it('rejects with an axios-shaped error (error.response) on a non-2xx status, matching existing callers\' error.response.status checks', async () => {
    // $FlowFixMe[prop-missing]
    TauriBridge.httpFetch.mockResolvedValueOnce({
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' },
      bodyBase64: toBase64('{"message":"not found"}'),
    });

    await expect(
      client.get('https://api.gdevelop.io/game/missing')
    ).rejects.toMatchObject({
      response: {
        status: 404,
        data: { message: 'not found' },
      },
    });
  });

  it('decodes a blob response as a Blob using the response Content-Type', async () => {
    // $FlowFixMe[prop-missing]
    TauriBridge.httpFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png' },
      bodyBase64: toBase64('fake-png-bytes'),
    });

    const response = await client.get('https://project-resources.gdevelop.io/x.png', {
      responseType: 'blob',
    });

    expect(response.data).toBeInstanceOf(BlobCtor);
    expect(response.data.type).toBe('image/png');
  });

  it('rejects with a network-error shape (no .response) when the Rust command itself fails, e.g. a real connection failure', async () => {
    // $FlowFixMe[prop-missing]
    TauriBridge.httpFetch.mockRejectedValueOnce(new Error('request failed: dns error'));

    await expect(
      client.get('https://api.gdevelop.io/unreachable')
    ).rejects.toMatchObject({
      message: expect.stringContaining('dns error'),
    });
  });
});
