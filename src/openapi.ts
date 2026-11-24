const id = { type: "string", format: "uuid" };
const dateTime = { type: "string", format: "date-time" };
const money = {
  type: "string",
  pattern: "^\\d+(\\.\\d{1,2})?$",
  example: "1250.50",
};
const error = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
};
const response = (schema: object) => ({ "application/json": { schema } });
const secured = [{ cookieAuth: [] }];
const json = (schema: object) => ({
  required: true,
  content: response(schema),
});
const message = (value: string) => ({
  content: response({
    type: "object",
    properties: { message: { type: "string", example: value } },
  }),
});

const schemas = {
  Error: error,
  User: {
    type: "object",
    required: ["id", "email", "fullName", "createdAt"],
    properties: {
      id,
      email: { type: "string", format: "email" },
      emailVerifiedAt: { ...dateTime, nullable: true },
      fullName: { type: "string" },
      businessName: { type: "string", nullable: true },
      logoUrl: { type: "string", nullable: true },
      address: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      createdAt: dateTime,
    },
  },
  SessionUser: {
    type: "object",
    required: ["id", "email", "fullName"],
    properties: {
      id,
      email: { type: "string", format: "email" },
      emailVerifiedAt: { ...dateTime, nullable: true },
      fullName: { type: "string" },
      businessName: { type: "string", nullable: true },
      logoUrl: { type: "string", nullable: true },
    },
  },
  ClientInput: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 2, maxLength: 200 },
      email: { type: "string", format: "email", maxLength: 254 },
      companyName: { type: "string", maxLength: 200 },
      phone: { type: "string", maxLength: 40 },
      address: { type: "string", maxLength: 2000 },
    },
  },
  Client: {
    type: "object",
    required: ["id", "userId", "name", "email", "createdAt", "updatedAt"],
    properties: {
      id,
      userId: id,
      name: { type: "string" },
      email: { type: "string", format: "email" },
      companyName: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      address: { type: "string", nullable: true },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },
  LineItemInput: {
    type: "object",
    required: ["description", "quantity", "rate"],
    properties: {
      description: { type: "string", maxLength: 500 },
      quantity: {
        type: "number",
        minimum: 0.01,
        maximum: 99999999.99,
        multipleOf: 0.01,
      },
      rate: {
        type: "number",
        minimum: 0.01,
        maximum: 99999999.99,
        multipleOf: 0.01,
      },
    },
  },
  InvoiceItem: {
    type: "object",
    required: [
      "id",
      "invoiceId",
      "description",
      "quantity",
      "rate",
      "amount",
      "createdAt",
    ],
    properties: {
      id,
      invoiceId: id,
      description: { type: "string" },
      quantity: money,
      rate: money,
      amount: money,
      createdAt: dateTime,
    },
  },
  Invoice: {
    type: "object",
    required: [
      "id",
      "clientId",
      "invoiceNumber",
      "status",
      "issueDate",
      "dueDate",
      "totalAmount",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id,
      clientId: id,
      invoiceNumber: { type: "string" },
      status: { type: "string", enum: ["draft", "sent", "paid", "overdue"] },
      issueDate: dateTime,
      dueDate: dateTime,
      totalAmount: money,
      notes: { type: "string", nullable: true },
      paystackRoutingRequired: { type: "boolean" },
      stripePaymentLink: {
        type: "string",
        format: "uri",
        nullable: true,
        description: "Legacy field name; contains the Paystack checkout URL.",
      },
      pdfUrl: { type: "string", nullable: true },
      deletedAt: { ...dateTime, nullable: true },
      createdAt: dateTime,
      updatedAt: dateTime,
      identitySnapshot: {
        type: "object",
        nullable: true,
        description:
          "The sender and client details captured when the invoice was issued. Use these for previously issued invoices.",
        properties: {
          sender: {
            type: "object",
            properties: {
              fullName: { type: "string" },
              businessName: { type: "string", nullable: true },
              email: { type: "string", format: "email" },
              address: { type: "string", nullable: true },
              phone: { type: "string", nullable: true },
              logoUrl: { type: "string", nullable: true },
            },
          },
          client: { $ref: "#/components/schemas/Client" },
        },
      },
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/InvoiceItem" },
      },
      client: { $ref: "#/components/schemas/Client" },
    },
  },
  InvoiceListItem: {
    type: "object",
    required: [
      "id",
      "invoiceNumber",
      "status",
      "issueDate",
      "dueDate",
      "totalAmount",
      "clientId",
      "clientName",
      "clientEmail",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id,
      invoiceNumber: { type: "string" },
      status: { type: "string", enum: ["draft", "sent", "paid", "overdue"] },
      issueDate: dateTime,
      dueDate: dateTime,
      totalAmount: money,
      notes: { type: "string", nullable: true },
      pdfUrl: { type: "string", nullable: true },
      stripePaymentLink: { type: "string", nullable: true },
      createdAt: dateTime,
      updatedAt: dateTime,
      clientId: id,
      clientName: { type: "string" },
      clientEmail: { type: "string", format: "email" },
      clientCompany: { type: "string", nullable: true },
    },
  },
  TrashedInvoiceListItem: {
    type: "object",
    required: [
      "id",
      "invoiceNumber",
      "status",
      "issueDate",
      "dueDate",
      "totalAmount",
      "deletedAt",
      "clientId",
      "clientName",
      "clientEmail",
    ],
    properties: {
      id,
      invoiceNumber: { type: "string" },
      status: { type: "string", enum: ["draft", "sent", "paid", "overdue"] },
      issueDate: dateTime,
      dueDate: dateTime,
      totalAmount: money,
      deletedAt: dateTime,
      clientId: id,
      clientName: { type: "string" },
      clientEmail: { type: "string", format: "email" },
    },
  },
  Payment: {
    type: "object",
    required: [
      "id",
      "invoiceId",
      "amountPaid",
      "paidAt",
      "method",
      "createdAt",
    ],
    properties: {
      id,
      invoiceId: id,
      amountPaid: money,
      paidAt: dateTime,
      method: {
        type: "string",
        enum: ["paystack", "cash", "bank_transfer", "other"],
      },
      stripePaymentId: {
        type: "string",
        nullable: true,
        description: "Legacy field name; contains the Paystack reference.",
      },
      reference: { type: "string", nullable: true },
      recordedBy: { ...id, nullable: true },
      createdAt: dateTime,
    },
  },
  EmailDelivery: {
    type: "object",
    required: ["id", "status", "attempts", "createdAt"],
    properties: {
      id,
      status: {
        type: "string",
        enum: ["pending", "processing", "accepted", "failed", "cancelled"],
      },
      attempts: { type: "integer" },
      acceptedAt: { ...dateTime, nullable: true },
      createdAt: dateTime,
      lastError: { type: "string", nullable: true },
    },
  },
  QueuedEmail: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id,
      status: {
        type: "string",
        enum: ["pending", "processing", "accepted", "failed", "cancelled"],
      },
    },
  },
  PayoutAccount: {
    type: "object",
    required: ["status", "mode", "bankCode", "accountLast4", "accountName"],
    properties: {
      status: { type: "string", enum: ["pending", "ready"] },
      mode: { type: "string", enum: ["test", "live"] },
      bankCode: { type: "string", pattern: "^\\d{3,6}$" },
      accountLast4: { type: "string", pattern: "^\\d{4}$" },
      accountName: { type: "string" },
    },
  },
  Pagination: {
    type: "object",
    required: ["limit", "hasMore", "nextCursor"],
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      hasMore: { type: "boolean" },
      nextCursor: {
        type: "string",
        nullable: true,
        description: "Opaque value. Send unchanged as cursor.",
      },
    },
  },
};

const pageParameters = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  },
  { name: "cursor", in: "query", schema: { type: "string" } },
  { name: "search", in: "query", schema: { type: "string", maxLength: 100 } },
];
const pathId = [{ name: "id", in: "path", required: true, schema: id }];
const protectedErrors = {
  "401": { description: "No valid session" },
  "403": { description: "Email is unverified or Origin is not FRONTEND_URL" },
  "429": {
    description: "Rate limited; read Retry-After",
    headers: { "Retry-After": { schema: { type: "integer" } } },
    content: response(error),
  },
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Billd API",
    version: "1.0.0",
    description:
      "Frontend contract for Billd. All authenticated browser calls use httpOnly cookies and `credentials: include`. Every POST, PUT, PATCH, and DELETE except `/webhooks/paystack` must send an Origin exactly matching FRONTEND_URL.",
  },
  servers: [{ url: "http://localhost:3001", description: "Local development" }],
  tags: [
    { name: "Auth" },
    { name: "Clients" },
    { name: "Invoices" },
    { name: "Payouts" },
    { name: "Health" },
    { name: "Webhooks" },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "access_token",
        description:
          "Set by register, login, refresh, or Google OAuth. Never read it in frontend JavaScript.",
      },
    },
    schemas,
  },
  paths: {
    "/": {
      get: {
        tags: ["Health"],
        responses: {
          "200": {
            description: "API information",
            content: response({
              type: "object",
              required: ["message", "version", "docs"],
              properties: {
                message: { type: "string" },
                version: { type: "string" },
                docs: { type: "string", example: "/docs" },
              },
            }),
          },
        },
      },
    },
    "/health": {
      get: {
        tags: ["Health"],
        responses: {
          "200": {
            description: "Live",
            content: response({
              type: "object",
              properties: {
                status: { type: "string", example: "ok" },
                timestamp: dateTime,
                service: { type: "string" },
              },
            }),
          },
        },
      },
    },
    "/health/ready": {
      get: {
        tags: ["Health"],
        responses: {
          "200": { description: "Database ready" },
          "503": { description: "Database unavailable or service draining" },
        },
      },
    },
    "/health/db": {
      get: {
        tags: ["Health"],
        deprecated: true,
        description:
          "Legacy database diagnostic. Deployments should use /health/ready.",
        responses: {
          "200": { description: "Database connected" },
          "500": {
            description: "Database unavailable",
            content: response(error),
          },
        },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Auth"],
        requestBody: json({
          type: "object",
          required: ["fullName", "email", "password"],
          properties: {
            fullName: { type: "string", minLength: 2 },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8, maxLength: 72 },
          },
        }),
        responses: {
          "201": {
            description: "Session cookies set; verification email queued",
            content: response({
              type: "object",
              properties: {
                message: { type: "string" },
                user: { $ref: "#/components/schemas/SessionUser" },
              },
            }),
          },
          "409": { description: "Email exists", content: response(error) },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        requestBody: json({
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
            rememberMe: { type: "boolean", default: false },
          },
        }),
        responses: {
          "200": {
            description: "Session cookies set",
            content: response({
              type: "object",
              properties: {
                message: { type: "string" },
                user: { $ref: "#/components/schemas/SessionUser" },
              },
            }),
          },
          "401": {
            description: "Invalid credentials",
            content: response(error),
          },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Auth"],
        responses: {
          "200": message("Tokens refreshed"),
          "401": {
            description: "Refresh cookie invalid",
            content: response(error),
          },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Auth"],
        responses: {
          "200": message("Logged out successfully"),
          "503": {
            description: "Could not revoke session",
            content: response(error),
          },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        security: secured,
        responses: {
          "200": {
            description: "Current account",
            content: response({ $ref: "#/components/schemas/User" }),
          },
          ...protectedErrors,
        },
      },
      patch: {
        tags: ["Auth"],
        security: secured,
        requestBody: json({
          type: "object",
          properties: {
            fullName: { type: "string", maxLength: 200 },
            phone: { type: "string", maxLength: 40 },
            businessName: { type: "string", maxLength: 200 },
            address: { type: "string", maxLength: 2000 },
            logoUrl: { type: "string", maxLength: 700000 },
          },
        }),
        responses: {
          "200": {
            description: "Profile updated",
            content: response({ $ref: "#/components/schemas/User" }),
          },
          ...protectedErrors,
        },
      },
    },
    "/auth/google": {
      get: {
        tags: ["Auth"],
        description:
          "Navigate browser here; redirects to Google or returns 503 if disabled.",
        responses: {
          "302": { description: "Google authorization" },
          "503": {
            description: "Google OAuth disabled",
            content: response(error),
          },
        },
      },
    },
    "/auth/google/callback": {
      get: {
        tags: ["Auth"],
        responses: {
          "302": {
            description:
              "Redirects frontend to dashboard or sign-in with an error query",
          },
        },
      },
    },
    "/auth/forgot-password": {
      post: {
        tags: ["Auth"],
        requestBody: json({
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", format: "email" } },
        }),
        responses: {
          "200": message(
            "If that email exists, a reset email has been queued.",
          ),
        },
      },
    },
    "/auth/reset-password": {
      post: {
        tags: ["Auth"],
        requestBody: json({
          type: "object",
          required: ["token", "password"],
          properties: {
            token: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
            password: { type: "string", minLength: 8, maxLength: 72 },
          },
        }),
        responses: {
          "200": message("Password updated successfully. You can now sign in."),
          "400": {
            description: "Invalid or expired token",
            content: response(error),
          },
        },
      },
    },
    "/auth/resend-verification": {
      post: {
        tags: ["Auth"],
        security: secured,
        responses: {
          "202": message(
            "If verification is needed, an email has been queued.",
          ),
          ...protectedErrors,
        },
      },
    },
    "/auth/verification-status": {
      get: {
        tags: ["Auth"],
        security: secured,
        responses: {
          "200": {
            description: "Latest verification delivery",
            content: response({
              type: "object",
              properties: {
                data: {
                  nullable: true,
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    acceptedAt: { ...dateTime, nullable: true },
                  },
                },
              },
            }),
          },
          ...protectedErrors,
        },
      },
    },
    "/auth/verify-email": {
      post: {
        tags: ["Auth"],
        security: secured,
        requestBody: json({
          type: "object",
          required: ["token"],
          properties: { token: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        }),
        responses: {
          "200": message("Email verified successfully"),
          ...protectedErrors,
        },
      },
    },
  } as Record<string, unknown>,
} as const;

const paths = openApiDocument.paths as Record<string, unknown>;
const collection = (
  name: "Client" | "InvoiceListItem" | "TrashedInvoiceListItem",
) => ({
  type: "object",
  properties: {
    data: { type: "array", items: { $ref: `#/components/schemas/${name}` } },
    pagination: { $ref: "#/components/schemas/Pagination" },
  },
});
paths["/clients"] = {
  get: {
    tags: ["Clients"],
    security: secured,
    parameters: pageParameters,
    responses: {
      "200": {
        description: "Cursor page",
        content: response(collection("Client")),
      },
      ...protectedErrors,
    },
  },
  post: {
    tags: ["Clients"],
    security: secured,
    requestBody: json({
      type: "object",
      required: ["name", "email"],
      properties: {
        name: { type: "string", minLength: 2, maxLength: 200 },
        email: { type: "string", format: "email", maxLength: 254 },
        companyName: { type: "string", maxLength: 200 },
        phone: { type: "string", maxLength: 40 },
        address: { type: "string", maxLength: 2000 },
      },
    }),
    responses: {
      "201": {
        description: "Created",
        content: response({
          type: "object",
          properties: {
            data: { $ref: "#/components/schemas/Client" },
            message: { type: "string" },
          },
        }),
      },
      ...protectedErrors,
    },
  },
};
paths["/clients/{id}"] = {
  get: {
    tags: ["Clients"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": {
        description: "Client",
        content: response({
          type: "object",
          properties: { data: { $ref: "#/components/schemas/Client" } },
        }),
      },
      "404": { description: "Missing", content: response(error) },
      ...protectedErrors,
    },
  },
  put: {
    tags: ["Clients"],
    security: secured,
    parameters: pathId,
    requestBody: json({ $ref: "#/components/schemas/ClientInput" }),
    responses: { "200": { description: "Updated" }, ...protectedErrors },
  },
  delete: {
    tags: ["Clients"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": message("Client deleted successfully"),
      "409": { description: "Client has invoices", content: response(error) },
      ...protectedErrors,
    },
  },
};
const invoiceRequest = {
  type: "object",
  required: ["clientId", "issueDate", "dueDate", "items"],
  properties: {
    clientId: id,
    issueDate: dateTime,
    dueDate: dateTime,
    notes: { type: "string", maxLength: 5000 },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: { $ref: "#/components/schemas/LineItemInput" },
    },
  },
};
paths["/invoices"] = {
  get: {
    tags: ["Invoices"],
    security: secured,
    parameters: [
      ...pageParameters,
      {
        name: "status",
        in: "query",
        schema: { type: "string", enum: ["draft", "sent", "paid", "overdue"] },
      },
      { name: "clientId", in: "query", schema: id },
    ],
    responses: {
      "200": {
        description: "Active invoices",
        content: response(collection("InvoiceListItem")),
      },
      ...protectedErrors,
    },
  },
  post: {
    tags: ["Invoices"],
    security: secured,
    requestBody: json(invoiceRequest),
    responses: {
      "201": {
        description: "Draft created",
        content: response({
          type: "object",
          properties: {
            data: { $ref: "#/components/schemas/Invoice" },
            message: { type: "string" },
          },
        }),
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/trash"] = {
  get: {
    tags: ["Invoices"],
    security: secured,
    parameters: pageParameters,
    responses: {
      "200": {
        description: "Soft-deleted invoices",
        content: response(collection("TrashedInvoiceListItem")),
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}"] = {
  get: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": {
        description: "Invoice with client and items",
        content: response({
          type: "object",
          properties: { data: { $ref: "#/components/schemas/Invoice" } },
        }),
      },
      ...protectedErrors,
    },
  },
  put: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    requestBody: json({ ...invoiceRequest, required: [] }),
    responses: {
      "200": { description: "Draft updated" },
      "409": {
        description: "Issued invoices cannot be edited",
        content: response(error),
      },
      ...protectedErrors,
    },
  },
  delete: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: { "200": message("Invoice moved to Trash"), ...protectedErrors },
  },
};
paths["/invoices/{id}/status"] = {
  patch: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    requestBody: json({
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["draft", "sent", "paid", "overdue"] },
      },
    }),
    responses: {
      "200": {
        description:
          "Only sent → overdue is a state change; paid must use a payment record.",
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/send"] = {
  post: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "202": {
        description: "Issued and email queued",
        content: response({
          type: "object",
          properties: {
            data: { $ref: "#/components/schemas/Invoice" },
            email: {
              type: "object",
              properties: {
                id,
                status: { type: "string", example: "pending" },
              },
            },
            message: { type: "string" },
          },
        }),
      },
      "409": {
        description:
          "Not a draft, or ready payout account required when Paystack is configured",
        content: response(error),
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/resend"] = {
  post: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "202": {
        description: "Email queued",
        content: response({
          type: "object",
          properties: {
            email: { $ref: "#/components/schemas/QueuedEmail" },
            message: { type: "string" },
          },
        }),
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/restore"] = {
  post: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": message("Invoice restored successfully"),
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/permanent"] = {
  delete: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": message("Invoice permanently deleted"),
      "409": {
        description: "Only trashed drafts may be permanently deleted",
        content: response(error),
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/pdf"] = {
  get: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": {
        description: "PDF download",
        content: {
          "application/pdf": { schema: { type: "string", format: "binary" } },
        },
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/email-deliveries"] = {
  get: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": {
        description: "Latest 20 delivery states",
        content: response({
          type: "object",
          properties: {
            data: {
              type: "array",
              items: { $ref: "#/components/schemas/EmailDelivery" },
            },
          },
        }),
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/payments"] = {
  get: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    responses: {
      "200": {
        description: "Payment history",
        content: response({
          type: "object",
          properties: {
            data: {
              type: "array",
              items: { $ref: "#/components/schemas/Payment" },
            },
          },
        }),
      },
      ...protectedErrors,
    },
  },
  post: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    requestBody: json({
      type: "object",
      required: ["amount", "paidAt", "method", "reference"],
      properties: {
        amount: money,
        paidAt: dateTime,
        method: { type: "string", enum: ["cash", "bank_transfer", "other"] },
        reference: { type: "string", maxLength: 200 },
      },
    }),
    responses: {
      "201": {
        description:
          "Offline payment recorded; requires Idempotency-Key header (16–128 URL-safe characters).",
      },
      ...protectedErrors,
    },
  },
};
paths["/invoices/{id}/payments/reconcile"] = {
  post: {
    tags: ["Invoices"],
    security: secured,
    parameters: pathId,
    requestBody: json({
      type: "object",
      required: ["reference"],
      properties: { reference: { type: "string", maxLength: 200 } },
    }),
    responses: {
      "200": {
        description: "Paystack verification result",
        content: response({
          type: "object",
          properties: {
            result: {
              type: "string",
              enum: ["recorded", "duplicate", "ignored"],
            },
          },
        }),
      },
      ...protectedErrors,
    },
  },
};
paths["/payouts/banks"] = {
  get: {
    tags: ["Payouts"],
    security: secured,
    parameters: [
      { name: "next", in: "query", schema: { type: "string", maxLength: 200 } },
    ],
    responses: {
      "200": {
        description:
          "Active Nigerian NGN banks; pass next unchanged until null.",
        content: response({
          type: "object",
          properties: {
            data: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  code: { type: "string" },
                },
              },
            },
            next: { type: "string", nullable: true },
          },
        }),
      },
      ...protectedErrors,
    },
  },
};
paths["/payouts/account"] = {
  get: {
    tags: ["Payouts"],
    security: secured,
    responses: {
      "200": {
        description: "Current environment payout account",
        content: response({
          type: "object",
          properties: {
            data: {
              allOf: [{ $ref: "#/components/schemas/PayoutAccount" }],
              nullable: true,
            },
            mode: { type: "string", enum: ["test", "live"] },
          },
        }),
      },
      ...protectedErrors,
    },
  },
  post: {
    tags: ["Payouts"],
    security: secured,
    requestBody: json({
      type: "object",
      required: ["bankCode", "accountNumber"],
      properties: {
        bankCode: { type: "string", pattern: "^\\d{3,6}$" },
        accountNumber: { type: "string", pattern: "^\\d{10}$" },
      },
    }),
    responses: {
      "200": {
        description: "Payout account ready or idempotent replay",
        content: response({
          type: "object",
          properties: { data: { $ref: "#/components/schemas/PayoutAccount" } },
        }),
      },
      "409": {
        description:
          "Pending setup, change attempt, or provider/environment mismatch",
        content: response(error),
      },
      ...protectedErrors,
    },
  },
};
paths["/webhooks/paystack"] = {
  post: {
    tags: ["Webhooks"],
    description:
      "Provider-only endpoint. Do not call from the frontend. Requires x-paystack-signature HMAC header.",
    security: [],
    responses: {
      "200": { description: "Accepted" },
      "401": { description: "Invalid signature" },
      "422": { description: "Payment conflict" },
    },
  },
};
paths["/openapi.json"] = {
  get: {
    tags: ["Health"],
    description: "The machine-readable OpenAPI contract used by the frontend.",
    responses: { "200": { description: "OpenAPI 3.1 document" } },
  },
};
paths["/docs"] = {
  get: {
    tags: ["Health"],
    description: "Interactive Swagger UI for this API contract.",
    responses: { "200": { description: "Swagger UI HTML" } },
  },
};
