# Complex Mermaid Demo: Atlas Commerce Platform

This fixture preserves the first three diagrams and their original sizes from the
reported complex Mermaid document.

## 1. System architecture

```mermaid
flowchart TB
    %% ---------- Clients ----------
    subgraph EDGE["Global Edge"]
        direction LR
        WEB["Web Storefront"]
        MOB["Mobile App"]
        PARTNER["Partner API"]
        CDN(("CDN + WAF"))
        WEB --> CDN
        MOB --> CDN
        PARTNER --> CDN
    end

    subgraph REGION_A["Primary Region · us-central"]
        direction TB
        GW["API Gateway"]

        subgraph SERVICES["Application Services"]
            direction LR
            AUTH["Identity Service"]
            CATALOG["Catalog Service"]
            CART["Cart Service"]
            ORDER["Order Orchestrator"]
            PAYMENT["Payment Adapter"]
            FULFILL["Fulfillment Service"]
            NOTIFY["Notification Service"]
        end

        subgraph DATA["Regional Data Plane"]
            direction LR
            PG[("PostgreSQL\nOrders + Accounts")]
            REDIS[("Redis\nSessions + Carts")]
            SEARCH[("Search Index\nProducts")]
            OBJECT[("Object Storage\nAssets + Receipts")]
        end

        BUS{{"Event Bus"}}
        FRAUD["Fraud Scoring Worker"]
        ANALYTICS["Analytics Stream"]
    end

    subgraph EXTERNAL["External Providers"]
        direction LR
        IDP["OIDC Provider"]
        PSP["Payment Processor"]
        SHIP["Shipping Carriers"]
        MSG["Email / SMS / Push"]
    end

    subgraph PLATFORM["Platform Control Plane"]
        direction LR
        CICD["CI/CD Pipeline"]
        FLAGS["Feature Flags"]
        SECRETS["Secrets Manager"]
        OBS["Metrics · Logs · Traces"]
        ONCALL["On-call + Incident Bot"]
    end

    CDN -->|"HTTPS"| GW
    GW --> AUTH
    GW --> CATALOG
    GW --> CART
    GW --> ORDER

    AUTH <--> PG
    AUTH --> IDP
    CATALOG --> SEARCH
    CATALOG --> OBJECT
    CART <--> REDIS
    ORDER --> PG
    ORDER --> PAYMENT
    PAYMENT --> PSP
    ORDER -->|"OrderCreated"| BUS
    PAYMENT -->|"PaymentAuthorized"| BUS
    BUS --> FRAUD
    BUS --> FULFILL
    BUS --> NOTIFY
    BUS --> ANALYTICS
    FULFILL --> SHIP
    NOTIFY --> MSG

    CICD -.->|"deploys"| SERVICES
    FLAGS -.->|"configures"| GW
    SECRETS -.->|"credentials"| PAYMENT
    SERVICES -.->|"telemetry"| OBS
    DATA -.->|"telemetry"| OBS
    OBS -->|"page on SLO breach"| ONCALL

    classDef client fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e,stroke-width:2px;
    classDef service fill:#ede9fe,stroke:#7c3aed,color:#3b0764,stroke-width:2px;
    classDef data fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px;
    classDef external fill:#fff7ed,stroke:#ea580c,color:#7c2d12;
    classDef platform fill:#f1f5f9,stroke:#475569,color:#0f172a,stroke-dasharray: 5 3;
    class WEB,MOB,PARTNER,CDN client;
    class GW,AUTH,CATALOG,CART,ORDER,PAYMENT,FULFILL,NOTIFY,FRAUD,ANALYTICS service;
    class PG,REDIS,SEARCH,OBJECT,BUS data;
    class IDP,PSP,SHIP,MSG external;
    class CICD,FLAGS,SECRETS,OBS,ONCALL platform;
```

## 2. Checkout orchestration sequence

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant UI as Storefront
    participant API as API Gateway
    participant Cart as Cart Service
    participant Order as Order Orchestrator
    participant Fraud as Fraud Engine
    participant Pay as Payment Processor
    participant Bus as Event Bus
    participant Fulfill as Fulfillment
    participant Notify as Notifications

    Customer->>UI: Confirm checkout
    UI->>API: POST /orders (idempotency key)
    API->>Cart: Lock cart and price snapshot
    Cart-->>API: Snapshot + inventory holds
    API->>Order: Create pending order

    par Risk assessment
        Order->>Fraud: Score customer and basket
        Fraud-->>Order: Risk score
    and Payment setup
        Order->>Pay: Create authorization
        Pay-->>Order: Authorization token
    end

    alt High risk
        Order->>Order: Mark REQUIRES_REVIEW
        Order-->>API: 202 Accepted
        API-->>UI: Review in progress
        UI-->>Customer: Show pending review
    else Acceptable risk
        Order->>Pay: Capture authorization
        alt Capture succeeds
            Pay-->>Order: Captured
            Order->>Bus: Publish OrderConfirmed
            par Downstream work
                Bus->>Fulfill: Reserve shipment
                Fulfill-->>Bus: ShipmentPlanned
            and Customer update
                Bus->>Notify: Send confirmation
                Notify-->>Customer: Email / push receipt
            end
            Order-->>API: 201 Created + order ID
            API-->>UI: Checkout complete
            UI-->>Customer: Display confirmation
        else Capture fails
            Pay-->>Order: Declined / timeout
            Order->>Cart: Release inventory holds
            Order-->>API: 402 Payment Required
            API-->>UI: Payment failed
            UI-->>Customer: Request another method
        end
    end

    opt Client retries after a timeout
        UI->>API: POST /orders (same idempotency key)
        API-->>UI: Return original response
    end
```

## 3. Order lifecycle state machine

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Pricing: checkout started
    Pricing --> PendingPayment: totals locked
    Pricing --> Cancelled: inventory unavailable

    state PendingPayment {
        [*] --> Authorizing
        Authorizing --> Authorized: approved
        Authorizing --> RetryWait: transient failure
        RetryWait --> Authorizing: backoff elapsed
        RetryWait --> Declined: retry limit reached
        Authorized --> [*]
        Declined --> [*]
    }

    PendingPayment --> FraudReview: payment authorized
    PendingPayment --> PaymentFailed: declined

    state FraudReview {
        [*] --> Scoring
        Scoring --> AutoApproved: score < 70
        Scoring --> ManualQueue: score 70–89
        Scoring --> Rejected: score >= 90
        ManualQueue --> AutoApproved: analyst approves
        ManualQueue --> Rejected: analyst rejects
    }

    FraudReview --> Confirmed: approved
    FraudReview --> Cancelled: rejected
    Confirmed --> Allocating
    Allocating --> PartiallyShipped: split fulfillment
    Allocating --> Shipped: single fulfillment
    PartiallyShipped --> Shipped: final parcel dispatched
    Shipped --> Delivered: carrier confirmation
    Delivered --> ReturnRequested: customer request
    ReturnRequested --> Refunded: return received
    Delivered --> Closed: return window elapsed
    Refunded --> Closed
    PaymentFailed --> Cancelled
    Cancelled --> [*]
    Closed --> [*]

    note right of FraudReview
      Manual review has a 15-minute SLO.
      Expiry triggers cancellation and release.
    end note
```

## Content after diagrams

The renderer remains interactive below all three replacements.
