export const ENCODINGS = [
    {
        "instructionId": "GCSSS1_SYS",
        "encodingId": "GCSSS1_SYS_CR_systeminstrs",
        "mnemonic": "SYS",
        "className": "System",
        "fileName": "gcsss1_sys.xml",
        "mask": 4294967264,
        "value": 3574298432,
        "bitCount": 27,
        "fields": [
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "op1",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "CRn",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
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
        "guards": [],
        "canonicalEncodingId": "SYS_CR_systeminstrs",
        "canonicalFileName": "sys.xml",
        "operandFamilyId": "gcs-sysl-alias"
    }
];
