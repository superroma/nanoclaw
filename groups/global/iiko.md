# iiko MCP Tools Reference

## Overview

iiko tools let you query the restaurant management system (bar-zebitlz.iiko.it) for sales analytics, product catalogs, employees, and organizational data. All tools are prefixed with `iiko_`.

## Tools

### iiko_olap_report

The primary analytics tool. Queries OLAP reports for sales, transactions, or deliveries.

**Always call `iiko_olap_columns` first** to discover available fields before building a report query.

**Parameters:**
- `report_type`: SALES, TRANSACTIONS, or DELIVERIES
- `date_from`: Start date (YYYY-MM-DD)
- `date_to`: End date (YYYY-MM-DD)
- `group_by_rows`: Fields to group by (array of strings)
- `aggregate_fields`: Fields to aggregate (array of strings)
- `filters`: Optional additional filters in iiko format (date and deletion filters are added automatically)

**Common fields for SALES reports:**

Grouping fields:
- Time: `YearOpen`, `MonthOpen`, `WeekInYearOpen`, `DayOfWeekOpen`, `HourOpen`, `OpenDate.Typed`
- Items: `DishName`, `DishCode`, `DishGroup`, `DishCategory`, `DishType`
- Orders: `OrderNum`, `TableNum`, `GuestNum`
- Staff: `WaiterName`, `Cashier`
- Location: `Department`, `Department.Id`

Aggregation fields:
- `DishSumInt` — revenue (сумма продаж)
- `DishAmountInt` — quantity sold (количество)
- `UniqOrderId` — unique order count
- `DishDiscountSumInt` — discount amount
- `ProductCostBase.OneItem` — cost price per item
- `FullSum` — full sum before discounts

**Example — weekly sales for 2024:**
```
report_type: SALES
date_from: 2024-01-01
date_to: 2024-12-31
group_by_rows: ["YearOpen", "WeekInYearOpen", "DayOfWeekOpen"]
aggregate_fields: ["UniqOrderId", "DishSumInt"]
```

### iiko_olap_columns

Discover all available fields for a report type. Returns each field's name, type, and whether it supports grouping, aggregation, or filtering.

**Parameters:**
- `report_type`: SALES, TRANSACTIONS, or DELIVERIES

### iiko_stores

List all stores/warehouses. No parameters.

### iiko_departments

List all departments/locations. No parameters.

### iiko_products

Get the full product catalog (menu items, ingredients, semi-finished products). No parameters.

### iiko_suppliers

List all suppliers. No parameters.

### iiko_employees

List all employees. No parameters.

## Filter Format

Additional filters can be passed to `iiko_olap_report` via the `filters` parameter. The following date and deletion filters are added automatically — you don't need to specify them:
- `OpenDate.Typed` (date range from date_from/date_to)
- `OrderDeleted` (NOT_DELETED only)
- `DeletedWithWriteoff` (excluded)
- `Storned` (excluded)

### Include/Exclude values filter
```json
{
  "DishType": {
    "filterType": "IncludeValues",
    "values": ["DISH", "MODIFIER"]
  }
}
```

### Range filter (for numeric fields)
```json
{
  "SessionNum": {
    "filterType": "Range",
    "from": 758,
    "to": 760,
    "includeHigh": true
  }
}
```

## Tips

- OLAP queries over large date ranges can be slow. Narrow the date range when possible.
- Use `iiko_olap_columns` to find the exact field names — they are case-sensitive.
- `DishSumInt` is revenue in kopecks/cents — divide by 100 for rubles if needed (check actual values first).
- The `Department.Id` field is useful for filtering by specific location.
