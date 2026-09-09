# floatcolumn-api

Tags: FloatColumn, column, table, float, number

FloatColumn

A Column for a floating-point number type field.
Stores decimal numbers with floating-point precision.


Signature

```typescript fluent
FloatColumn(config)
```


Usage

```typescript fluent
const price = FloatColumn({
    label: 'Price',
    default: 99.99,
    scale: 2,
})

const temperature = FloatColumn({
    label: 'Temperature (Celsius)',
    default: 23.5,
    scale: 1,
    mandatory: true,
})
```

Parameters

config

object

Properties:

• scale (optional): number
  Number of decimal places to display.
  Controls the precision of the floating-point number.



See

• https://docs.servicenow.com/csh?topicname=table-api-now-ts.html&version=latest
