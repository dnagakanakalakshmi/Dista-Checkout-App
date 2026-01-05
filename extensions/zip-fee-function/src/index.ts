import {
  CartTransformInput,
  CartTransformResult,
} from "../generated/api";

const FEE_MARKER_KEY = "__zip_fee_internal";
const FEE_MARKER_VALUE = "true";

type ZipFeeRule = {
  countries: string[];
  zipPatterns: string[];
  feeType: "flat" | "percent";
  feeValue: number;
  title: string;
};

const RULES: ZipFeeRule[] = [
  {
    countries: ["IN"],
    zipPatterns: ["^560\\d{3}$"],
    feeType: "flat",
    feeValue: 150,
    title: "Remote Area Fee",
  },
  {
    countries: ["US", "CA"],
    zipPatterns: ["^9\\d{4}$"],
    feeType: "percent",
    feeValue: 3,
    title: "Regional Handling Fee",
  },
];

export function cartTransformRun(
  input: CartTransformInput
): CartTransformResult {
  const zip = input.shippingAddress?.postalCode;
  const country = input.shippingAddress?.countryCode;

  const feeLine = input.cart.lines.find((line) =>
    line.attributes?.some(
      (a) => a.key === FEE_MARKER_KEY && a.value === FEE_MARKER_VALUE
    )
  );

  const zipMatches =
    !!zip &&
    !!country &&
    RULES.some(
      (r) =>
        r.countries.includes(country) &&
        r.zipPatterns.some((p) => new RegExp(p).test(zip))
    );

  // Remove fee if ZIP no longer matches
  if (!zipMatches && feeLine) {
    return {
      operations: [
        {
          removeLineItem: {
            lineId: feeLine.id,
          },
        },
      ],
    };
  }

  // Do nothing if no match
  if (!zipMatches || feeLine) {
    return { operations: [] };
  }

  const rule = RULES.find(
    (r) =>
      r.countries.includes(country!) &&
      r.zipPatterns.some((p) => new RegExp(p).test(zip!))
  );

  if (!rule) return { operations: [] };

  const subtotal = Number(
    input.cart.cost.subtotalAmount.amount
  );

  const amount =
    rule.feeType === "flat"
      ? rule.feeValue
      : (subtotal * rule.feeValue) / 100;

  return {
    operations: [
      {
        addLineItem: {
          title: rule.title,
          quantity: 1,
          price: {
            amount: amount.toFixed(2),
            currencyCode:
              input.cart.cost.subtotalAmount.currencyCode,
          },
          taxable: false,
          attributes: [
            {
              key: FEE_MARKER_KEY,
              value: FEE_MARKER_VALUE,
            },
          ],
        },
      },
    ],
  };
}
