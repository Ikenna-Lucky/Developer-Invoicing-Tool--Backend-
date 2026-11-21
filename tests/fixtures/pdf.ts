import type { PDFInput } from "../../src/lib/pdf";

export const pngLogo =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";

export function invoicePdfInput(): PDFInput {
  const date = new Date("2026-11-21T00:00:00Z");
  return {
    sender: {
      id: "owner",
      email: "owner@example.test",
      fullName: "Test Owner",
      businessName: "Test Studio",
      address: "Lagos",
      phone: "08000000000",
      logoUrl: pngLogo,
      passwordHash: null,
      googleId: null,
      sessionVersion: 0,
      emailVerifiedAt: date,
      createdAt: date,
      updatedAt: date,
    },
    invoice: {
      id: "invoice",
      userId: "owner",
      clientId: "client",
      invoiceNumber: "INV-0001",
      status: "sent",
      issueDate: date,
      dueDate: date,
      totalAmount: "1250.50",
      notes: "Thanks for your business.",
      pdfUrl: null,
      stripePaymentLink: "https://checkout.paystack.com/example",
      deletedAt: null,
      createdAt: date,
      updatedAt: date,
      client: {
        id: "client",
        userId: "owner",
        name: "Test Client",
        email: "client@example.test",
        companyName: "Client Ltd",
        address: "Abuja",
        phone: "08000000001",
        createdAt: date,
        updatedAt: date,
      },
      items: [
        {
          id: "item",
          invoiceId: "invoice",
          description: "Backend development",
          quantity: "1.00",
          rate: "1250.50",
          amount: "1250.50",
          createdAt: date,
        },
      ],
    },
  };
}
