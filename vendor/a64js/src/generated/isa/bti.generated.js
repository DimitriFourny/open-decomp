export const ENCODINGS = [
    {
        "instructionId": "BTI",
        "encodingId": "BTI_HB_hints",
        "mnemonic": "BTI",
        "className": "System",
        "fileName": "bti.xml",
        "mask": 4294967103,
        "value": 3573752863,
        "bitCount": 30,
        "fields": [
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
            }
        ],
        "features": [
            "FEAT_BTI"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_BTI",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "bti"
    }
];
