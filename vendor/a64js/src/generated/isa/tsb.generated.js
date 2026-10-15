export const ENCODINGS = [
    {
        "instructionId": "TSB",
        "encodingId": "TSB_HC_hints",
        "mnemonic": "TSB",
        "className": "System",
        "fileName": "tsb.xml",
        "mask": 4294967295,
        "value": 3573752415,
        "bitCount": 32,
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
            "FEAT_TRF"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_TRF",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "tsb"
    }
];
