import { Fragment } from 'react';

// Isolate the existing formatted buckets; keep their text, separator and order intact.
// No amounts, currencies or totals are calculated here.
export default function CurrencyValue({ formattedValue }: { formattedValue: string }) {
  return <>{formattedValue.split(' + ').map((bucket, index) => (
    <Fragment key={index}>
      {index > 0 && ' + '}<bdi className="currency-bucket" dir="auto">{bucket}</bdi>
    </Fragment>
  ))}</>;
}
