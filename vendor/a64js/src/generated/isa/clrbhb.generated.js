export const ENCODINGS = [
    {
        "instructionId": "CLRBHB",
        "encodingId": "CLRBHB_HI_hints",
        "mnemonic": "CLRBHB",
        "className": "System",
        "fileName": "clrbhb.xml",
        "mask": 4294967295,
        "value": 3573752543,
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
            "FEAT_CLRBHB"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_CLRBHB",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "no-operands"
    }
];
