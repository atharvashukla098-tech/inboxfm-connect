import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PropertyType } from '@inboxfm-connect/pieces-framework';
import { HttpError } from '@inboxfm-connect/pieces-common';
import { createTimeTrackingAction } from './create-time-tracking';
import { createProductAction } from './create-product';
import { createSalesOrderAction } from './create-sales-order';
import { updateProductAction } from './update-product';
import { newOrderTrigger } from '../triggers/new-order';
import { BexioClient } from '../common/client';
import { extractErrorMessage, fetchBexioListOrLog } from '../common';
import { bexioAuth } from '../auth';

vi.mock('../common/client', () => {
  return {
    BexioClient: vi.fn(),
  };
});

describe('Bexio Dropdown Endpoints & Error Handling', () => {
  const mockAuth = { access_token: 'fake-token' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('bexioAuth scopes (#185)', () => {
    it('requests general and stock_edit OAuth scopes required for verified dropdown endpoints', () => {
      expect(bexioAuth.scope).toContain('general');
      expect(bexioAuth.scope).toContain('stock_edit');
    });
  });

  describe('extractErrorMessage helper (#185)', () => {
    it('extracts human-readable message from serialized HttpError JSON string', () => {
      const serialized = JSON.stringify({
        response: {
          status: 403,
          body: { message: 'Insufficient permissions for stock_edit' },
        },
        request: { body: {} },
      });
      const result = extractErrorMessage(new Error(serialized), 'fallback');
      expect(result).toBe('Insufficient permissions for stock_edit');
    });

    it('extracts status code if serialized HttpError body has no message', () => {
      const serialized = JSON.stringify({
        response: {
          status: 404,
          body: {},
        },
        request: { body: {} },
      });
      const result = extractErrorMessage(new Error(serialized), 'fallback');
      expect(result).toBe('HTTP 404');
    });

    it('extracts message from HttpError instance', () => {
      const httpErr = new HttpError({}, {
        status: 401,
        responseBody: { message: 'Token expired' },
      });
      const result = extractErrorMessage(httpErr, 'fallback');
      expect(result).toBe('Token expired');
    });

    it('extracts message from error object with response.data.message', () => {
      const err = { response: { data: { message: 'Rate limit exceeded' } } };
      const result = extractErrorMessage(err, 'fallback');
      expect(result).toBe('Rate limit exceeded');
    });

    it('returns standard Error message or fallback for unformatted errors', () => {
      expect(extractErrorMessage(new Error('Network timeout'), 'fallback')).toBe(
        'Network timeout'
      );
      expect(extractErrorMessage(null, 'Default fallback')).toBe('Default fallback');
    });
  });

  describe('createTimeTrackingAction', () => {
    it('timesheet status dropdown should call /2.0/timesheet_status and return options', async () => {
      const mockGet = vi.fn().mockResolvedValue([
        { id: 1, name: 'Open' },
        { id: 2, name: 'Done' },
      ]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const statusProp = createTimeTrackingAction.props.status_id as any;
      const result = await statusProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/timesheet_status');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([
        { label: 'Open', value: 1 },
        { label: 'Done', value: 2 },
      ]);
    });

    it('timesheet status dropdown should return diagnostic placeholder on failure instead of empty options', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Network error'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const statusProp = createTimeTrackingAction.props.status_id as any;
      const result = await statusProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Network error');
      expect(result.options).toEqual([]);
    });

    it('timesheet status dropdown extracts readable message from serialized HttpError', async () => {
      const httpError = new HttpError({}, {
        status: 403,
        responseBody: { message: 'Scope general is required' },
      });
      const mockGet = vi.fn().mockRejectedValue(httpError);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const statusProp = createTimeTrackingAction.props.status_id as any;
      const result = await statusProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Scope general is required');
      expect(result.options).toEqual([]);
    });

    it('client service dropdown should call /2.0/client_service and return options', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValue([{ id: 10, name: 'Consulting' }]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const serviceProp = createTimeTrackingAction.props
        .client_service_id as any;
      const result = await serviceProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/client_service');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([{ label: 'Consulting', value: 10 }]);
    });

    it('client service dropdown should return diagnostic placeholder on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('API 500'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const serviceProp = createTimeTrackingAction.props
        .client_service_id as any;
      const result = await serviceProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: API 500');
      expect(result.options).toEqual([]);
    });
  });

  describe('createProductAction', () => {
    it('stock dropdown should call /2.0/stock and return options', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValue([{ id: 100, name: 'Main Warehouse' }]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockProp = createProductAction.props.stock_id as any;
      const result = await stockProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/stock');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([{ label: 'Main Warehouse', value: 100 }]);
    });

    it('stock dropdown should return diagnostic placeholder on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Unauthorized'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockProp = createProductAction.props.stock_id as any;
      const result = await stockProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Unauthorized');
      expect(result.options).toEqual([]);
    });

    it('stock place dropdown should call /2.0/stock_place and return options', async () => {
      const mockGet = vi.fn().mockResolvedValue([{ id: 200, name: 'Aisle 3' }]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const placeProp = createProductAction.props.stock_place_id as any;
      const result = await placeProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/stock_place');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([{ label: 'Aisle 3', value: 200 }]);
    });

    it('stock place dropdown should return diagnostic placeholder on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Forbidden: stock_edit scope missing'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const placeProp = createProductAction.props.stock_place_id as any;
      const result = await placeProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Forbidden: stock_edit scope missing');
      expect(result.options).toEqual([]);
    });

    it('article_group_id is a numeric property rather than an unverified dropdown (#185)', () => {
      const articleGroupProp = createProductAction.props.article_group_id;
      expect(articleGroupProp.type).toBe(PropertyType.NUMBER);
      expect((articleGroupProp as any).options).toBeUndefined();
    });
  });

  describe('updateProductAction', () => {
    it('update product stock and stock_place dropdowns call verified endpoints', async () => {
      const mockGet = vi.fn().mockImplementation((endpoint: string) => {
        if (endpoint === '/2.0/stock')
          return Promise.resolve([{ id: 1, name: 'Warehouse' }]);
        if (endpoint === '/2.0/stock_place')
          return Promise.resolve([{ id: 2, name: 'Shelf B' }]);
        return Promise.reject(new Error('Unknown endpoint'));
      });
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockRes = await (
        updateProductAction.props.stock_id as any
      ).options({ auth: mockAuth });
      const placeRes = await (
        updateProductAction.props.stock_place_id as any
      ).options({ auth: mockAuth });

      expect(stockRes.disabled).toBe(false);
      expect(placeRes.disabled).toBe(false);
      expect(mockGet).toHaveBeenCalledWith('/2.0/stock');
      expect(mockGet).toHaveBeenCalledWith('/2.0/stock_place');
    });

    it('update product stock and stock_place dropdowns return diagnostic placeholders on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Service Unavailable'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockRes = await (
        updateProductAction.props.stock_id as any
      ).options({ auth: mockAuth });
      const placeRes = await (
        updateProductAction.props.stock_place_id as any
      ).options({ auth: mockAuth });

      expect(stockRes.disabled).toBe(true);
      expect(stockRes.placeholder).toBe('Connection test failed: Service Unavailable');
      expect(stockRes.options).toEqual([]);

      expect(placeRes.disabled).toBe(true);
      expect(placeRes.placeholder).toBe('Connection test failed: Service Unavailable');
      expect(placeRes.options).toEqual([]);
    });

    it('article_group_id is a numeric property on updateProductAction (#185)', () => {
      const articleGroupProp = updateProductAction.props.article_group_id;
      expect(articleGroupProp.type).toBe(PropertyType.NUMBER);
      expect((articleGroupProp as any).options).toBeUndefined();
    });
  });

  describe('fetchBexioListOrLog (#185 follow-up)', () => {
    it('returns the list untouched when the endpoint succeeds', async () => {
      const list = [{ id: 1, name: 'Piece' }];
      const get = vi.fn().mockResolvedValue(list);

      const result = await fetchBexioListOrLog({
        client: { get },
        endpoint: '/2.0/unit',
        label: 'units',
      });

      expect(result).toEqual(list);
      expect(get).toHaveBeenCalledWith('/2.0/unit');
    });

    it('degrades to an empty list and logs the reason when the endpoint fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const get = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await fetchBexioListOrLog({
        client: { get },
        endpoint: '/2.0/unit',
        label: 'units',
      });

      expect(result).toEqual([]);
      // An empty dropdown is indistinguishable from a legitimately empty collection, so the
      // failure has to leave a trace or the degradation is undiagnosable.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load units from Bexio API (/2.0/unit): Network error'),
        expect.anything()
      );
      errorSpy.mockRestore();
    });
  });

  describe('sales position dropdowns stay independent and visible (#185 follow-up)', () => {
    // A single try/catch wrapped around all three calls would let one failure suppress the
    // unrelated dropdowns that did load, which is the regression this guards. The contract is
    // asserted through the client calls and the logs rather than through the returned property
    // tree, whose shape is owned by the framework's zod schemas.
    it('still requests accounts and taxes after units fails, and reports only that failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const get = vi.fn().mockImplementation((endpoint: string) => {
        if (endpoint === '/2.0/unit') {
          return Promise.reject(new Error('Scope unit is required'));
        }
        if (endpoint === '/accounts') {
          return Promise.resolve([{ id: 7, account_no: '1000', name: 'Sales' }]);
        }
        return Promise.resolve([
          { id: 3, name: 'MWST', value: 8.1, display_name: 'MWST 8.1' },
        ]);
      });
      mockBexioClient(get);

      const result = await positionFields().props({ auth: mockAuth });

      expect(Object.keys(result)).toContain('positions');
      const requested = get.mock.calls.map((call) => call[0]);
      expect(requested).toContain('/2.0/unit');
      expect(requested).toContain('/accounts');
      expect(requested).toContain('/3.0/taxes?types=sales_tax&scope=active');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load units from Bexio API (/2.0/unit)'),
        expect.anything()
      );
      errorSpy.mockRestore();
    });

    it('reports every endpoint separately instead of aborting on the first failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const get = vi.fn().mockRejectedValue(new Error('Service Unavailable'));
      mockBexioClient(get);

      const result = await positionFields().props({ auth: mockAuth });

      // The position field degrades to manual numeric entry rather than throwing, so a broken
      // connection still lets the user enter IDs by hand.
      expect(Object.keys(result)).toContain('positions');
      expect(get).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledTimes(3);
      errorSpy.mockRestore();
    });
  });

  describe('trigger status dropdowns report failures (#185 follow-up)', () => {
    it('logs the failure and falls back to triggering for all statuses', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const get = vi.fn().mockRejectedValue(new Error('Forbidden'));
      mockBexioClient(get);

      const result = await orderStatusOptions()({ auth: mockAuth });

      expect(result.disabled).toBe(false);
      expect(result.placeholder).toBe(
        'Status filter not available - will trigger for all statuses'
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to load statuses from Bexio API (/2.0/kb_order_status): Forbidden'
        ),
        expect.anything()
      );
      errorSpy.mockRestore();
    });
  });
});

function mockBexioClient(get: ReturnType<typeof vi.fn>): void {
  vi.mocked(BexioClient).mockImplementation(
    () => ({ get }) as unknown as BexioClient
  );
}

function positionFields(): {
  props: (params: { auth: unknown }) => Promise<Record<string, unknown>>;
} {
  return createSalesOrderAction.props
    .positionFields as unknown as ReturnType<typeof positionFields>;
}

function orderStatusOptions(): (params: {
  auth: unknown;
}) => Promise<{ disabled: boolean; placeholder?: string; options: unknown[] }> {
  const statusId = newOrderTrigger.props.status_id as unknown as {
    options: (params: { auth: unknown }) => Promise<{
      disabled: boolean;
      placeholder?: string;
      options: unknown[];
    }>;
  };
  return statusId.options;
}
