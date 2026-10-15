export const ENCODINGS = [
    {
        "instructionId": "DGH",
        "encodingId": "DGH_HI_hints",
        "mnemonic": "DGH",
        "className": "System",
        "fileName": "dgh.xml",
        "mask": 4294967295,
        "value": 3573752031,
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
            "FEAT_DGH"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_DGH",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "no-operands"
    }
];
