export const ENCODINGS = [
    {
        "instructionId": "ESB",
        "encodingId": "ESB_HI_hints",
        "mnemonic": "ESB",
        "className": "System",
        "fileName": "esb.xml",
        "mask": 4294967295,
        "value": 3573752351,
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
            "FEAT_RAS"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_RAS",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "no-operands"
    }
];
