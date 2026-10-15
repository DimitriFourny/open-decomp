export const ENCODINGS = [
    {
        "instructionId": "GCSB",
        "encodingId": "GCSB_HD_hints",
        "mnemonic": "GCSB",
        "className": "System",
        "fileName": "gcsb.xml",
        "mask": 4294967295,
        "value": 3573752447,
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
            "FEAT_GCS"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_GCS",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "gcsb"
    }
];
