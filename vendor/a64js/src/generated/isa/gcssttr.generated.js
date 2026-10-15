export const ENCODINGS = [
    {
        "instructionId": "GCSSTTR",
        "encodingId": "GCSSTTR_64_ldst_gcs",
        "mnemonic": "GCSSTTR",
        "className": "Integer",
        "fileName": "gcssttr.xml",
        "mask": 4294966272,
        "value": 3642694656,
        "bitCount": 22,
        "fields": [
            {
                "name": "opc",
                "lsb": 12,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
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
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "gcs-store"
    }
];
