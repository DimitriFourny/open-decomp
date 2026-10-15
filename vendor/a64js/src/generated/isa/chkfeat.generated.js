export const ENCODINGS = [
    {
        "instructionId": "CHKFEAT",
        "encodingId": "CHKFEAT_HF_hints",
        "mnemonic": "CHKFEAT",
        "className": "System",
        "fileName": "chkfeat.xml",
        "mask": 4294967295,
        "value": 3573753119,
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
            "FEAT_CHK"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_CHK",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "chkfeat"
    }
];
