import { expect, test } from "bun:test";
import { openApiDocument } from "../src/openapi";

test("the frontend API contract documents every backend route group", () => {
  const paths = openApiDocument.paths as Record<
    string,
    Record<string, unknown>
  >;
  for (const [path, methods] of Object.entries({
    "/": ["get"],
    "/health": ["get"],
    "/health/ready": ["get"],
    "/health/db": ["get"],
    "/auth/register": ["post"],
    "/auth/login": ["post"],
    "/auth/refresh": ["post"],
    "/auth/logout": ["post"],
    "/auth/me": ["get", "patch"],
    "/auth/google": ["get"],
    "/auth/google/callback": ["get"],
    "/auth/forgot-password": ["post"],
    "/auth/reset-password": ["post"],
    "/auth/resend-verification": ["post"],
    "/auth/verification-status": ["get"],
    "/auth/verify-email": ["post"],
    "/clients": ["get", "post"],
    "/clients/{id}": ["get", "put", "delete"],
    "/invoices": ["get", "post"],
    "/invoices/trash": ["get"],
    "/invoices/{id}": ["get", "put", "delete"],
    "/invoices/{id}/status": ["patch"],
    "/invoices/{id}/send": ["post"],
    "/invoices/{id}/resend": ["post"],
    "/invoices/{id}/restore": ["post"],
    "/invoices/{id}/permanent": ["delete"],
    "/invoices/{id}/pdf": ["get"],
    "/invoices/{id}/email-deliveries": ["get"],
    "/invoices/{id}/payments": ["get", "post"],
    "/invoices/{id}/payments/reconcile": ["post"],
    "/payouts/banks": ["get"],
    "/payouts/account": ["get", "post"],
    "/webhooks/paystack": ["post"],
    "/openapi.json": ["get"],
    "/docs": ["get"],
  }))
    for (const method of methods) expect(paths[path]?.[method]).toBeDefined();
  expect(
    openApiDocument.components.schemas.Invoice.properties.stripePaymentLink
      .description,
  ).toContain("Paystack");
});
